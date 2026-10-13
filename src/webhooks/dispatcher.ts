import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import type { PrismaClient } from '../db/client.js';
import type { EngineEvent } from '../events/types.js';
import {
  ALL_EVENTS,
  type EventSink,
  type WebhookEventType,
  type WebhookPayload,
} from './events.js';
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signatureHeader } from './signing.js';

/**
 * Webhook delivery.
 *
 * `emit` writes one delivery row per subscribed endpoint and makes the first
 * attempt straight away. A failed attempt is rescheduled with exponential
 * backoff; the poller started by {@link WebhookDispatcher.start} picks up
 * whatever is due. After `maxAttempts` a delivery parks in `FAILED` — the
 * dead-letter state — until someone retries it by hand.
 *
 * Every attempt first *claims* its row by pushing `nextAttemptAt` out by a
 * lease, conditional on the row still being due. Only one worker can win that
 * update, so several engine instances can share one database without
 * double-sending.
 */

export interface WebhookLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface WebhookDispatcherOptions {
  prisma: PrismaClient;
  maxAttempts: number;
  retryBaseSeconds: number;
  timeoutMs: number;
  fetch?: typeof fetch;
  logger?: WebhookLogger;
  now?: () => Date;
  /** Deliveries one poll picks up. */
  batchSize?: number;
}

/** Longest gap between two attempts of one delivery. */
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;
/** How much of a receiver's response body the delivery log keeps. */
const RESPONSE_EXCERPT_CHARS = 2048;

export type DeliveryRow = Awaited<ReturnType<PrismaClient['webhookDelivery']['findFirst']>> & {};

export class WebhookDispatcher implements EventSink {
  private readonly prisma: PrismaClient;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly pending = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(private readonly options: WebhookDispatcherOptions) {
    this.prisma = options.prisma;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  emit(tenantId: string, type: WebhookEventType, data: Record<string, unknown>): void {
    this.track(
      this.publish(tenantId, type, data).catch((err: unknown) => {
        this.options.logger?.error({ err, tenantId, type }, 'webhook enqueue failed');
      }),
    );
  }

  /**
   * Enqueue an event for every enabled endpoint subscribed to it — or for one
   * named endpoint regardless of its subscriptions — and make the first
   * attempt. Resolves with the delivery ids once those attempts finish.
   */
  async publish(
    tenantId: string,
    type: WebhookEventType,
    data: Record<string, unknown>,
    target?: { endpointId: string },
  ): Promise<string[]> {
    const now = this.now();
    const payload: WebhookPayload = { id: `evt_${randomUUID()}`, type, createdAt: now.toISOString(), data };
    const ids = await this.queue(tenantId, payload, target);
    await Promise.all(ids.map((id) => this.deliver(id)));
    return ids;
  }

  /**
   * The event bus's webhook subscriber: queue a bus event for every subscribed
   * endpoint, keeping the bus's event id so receivers can dedupe across hops.
   * Idempotent on that id — a transport that redelivers never double-queues.
   * Resolves once the delivery rows are written; first attempts carry on in
   * the background.
   */
  async enqueue(event: EngineEvent): Promise<string[]> {
    const payload: WebhookPayload = { id: event.id, type: event.type, createdAt: event.createdAt, data: event.data };
    const ids = await this.queue(event.tenantId, payload);
    for (const id of ids) {
      this.track(
        this.deliver(id).catch((err: unknown) => {
          this.options.logger?.error({ err, deliveryId: id }, 'webhook delivery attempt failed');
        }),
      );
    }
    return ids;
  }

  /** Write one PENDING delivery per target endpoint that doesn't already have this event. */
  private async queue(
    tenantId: string,
    payload: WebhookPayload,
    target?: { endpointId: string },
  ): Promise<string[]> {
    const endpoints = target
      ? await this.prisma.webhookEndpoint.findMany({ where: { tenantId, id: target.endpointId } })
      : (await this.prisma.webhookEndpoint.findMany({ where: { tenantId, enabled: true } })).filter(
          (e) => e.events.includes(ALL_EVENTS) || e.events.includes(payload.type),
        );
    if (endpoints.length === 0) return [];

    const existing = await this.prisma.webhookDelivery.findMany({
      where: { tenantId, eventId: payload.id },
      select: { endpointId: true },
    });
    const queued = new Set(existing.map((d) => d.endpointId));

    const now = this.now();
    const ids: string[] = [];
    for (const endpoint of endpoints) {
      if (queued.has(endpoint.id)) continue;
      const row = await this.prisma.webhookDelivery.create({
        data: {
          tenantId,
          endpointId: endpoint.id,
          eventId: payload.id,
          eventType: payload.type,
          payload: payload as unknown as Prisma.InputJsonValue,
          status: 'PENDING',
          nextAttemptAt: now,
        },
      });
      ids.push(row.id);
    }
    return ids;
  }

  /**
   * Re-send a delivery now, whatever state it is in. A manual retry gets one
   * attempt: if it fails, the delivery goes (back) to `FAILED`.
   */
  async redeliver(deliveryId: string): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'PENDING', nextAttemptAt: this.now() },
    });
    await this.deliver(deliveryId, { final: true });
  }

  /** Attempt every delivery that is due. Resolves with how many were attempted. */
  async processDue(): Promise<number> {
    const due = await this.prisma.webhookDelivery.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: this.now() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: this.options.batchSize ?? 50,
      select: { id: true },
    });
    await Promise.all(due.map((row) => this.deliver(row.id)));
    return due.length;
  }

  /** Poll for due retries every `intervalMs`. The timer never holds the process open. */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      this.track(
        this.processDue()
          .catch((err: unknown) => this.options.logger?.error({ err }, 'webhook poll failed'))
          .finally(() => {
            this.polling = false;
          }),
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  /** Stop polling and wait for in-flight work. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.idle();
  }

  /** Resolves once every emit and attempt started so far has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  backoffSeconds(failedAttempts: number): number {
    return Math.min(this.options.retryBaseSeconds * 2 ** Math.max(0, failedAttempts - 1), MAX_BACKOFF_SECONDS);
  }

  // ---- internals -----------------------------------------------------------

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }

  private async deliver(deliveryId: string, opts: { final?: boolean } = {}): Promise<void> {
    const now = this.now();
    const lease = new Date(now.getTime() + this.options.timeoutMs + 30_000);
    const claimed = await this.prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, status: 'PENDING', nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: lease },
    });
    if (claimed.count === 0) return;

    const delivery = await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId } });
    if (!delivery) return;
    const endpoint = await this.prisma.webhookEndpoint.findFirst({ where: { id: delivery.endpointId } });
    if (!endpoint) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'FAILED', nextAttemptAt: null, lastError: 'Endpoint was deleted' },
      });
      return;
    }

    const body = JSON.stringify(delivery.payload);
    let statusCode: number | null = null;
    let error: string | null = null;
    let excerpt: string | null = null;
    try {
      const res = await this.fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'ScormFlow-Webhooks/1',
          [EVENT_HEADER]: delivery.eventType,
          [DELIVERY_HEADER]: delivery.id,
          [SIGNATURE_HEADER]: signatureHeader(endpoint.secret, body, now),
        },
        body,
        // A redirect is a failure, not something to follow: following one could
        // walk the request somewhere the URL policy would have refused.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      statusCode = res.status;
      excerpt = (await res.text().catch(() => '')).slice(0, RESPONSE_EXCERPT_CHARS) || null;
      if (res.status < 200 || res.status >= 300) error = `Receiver answered HTTP ${res.status}`;
    } catch (err) {
      error = describeFetchError(err, this.options.timeoutMs);
    }

    const attempts = delivery.attempts + 1;
    const finishedAt = this.now();
    const common = {
      attempts,
      lastAttemptAt: finishedAt,
      lastStatusCode: statusCode,
      lastError: error,
      lastResponse: excerpt,
    };

    if (!error) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { ...common, status: 'SUCCEEDED', deliveredAt: finishedAt, nextAttemptAt: null },
      });
      return;
    }

    const exhausted = opts.final || attempts >= this.options.maxAttempts;
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: exhausted
        ? { ...common, status: 'FAILED', nextAttemptAt: null }
        : {
            ...common,
            status: 'PENDING',
            nextAttemptAt: new Date(finishedAt.getTime() + this.backoffSeconds(attempts) * 1000),
          },
    });
    if (exhausted) {
      this.options.logger?.warn(
        { deliveryId, endpointId: endpoint.id, attempts, error },
        'webhook delivery failed permanently',
      );
    }
  }
}

function describeFetchError(err: unknown, timeoutMs: number): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return `Timed out after ${timeoutMs} ms`;
  const message = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return cause ? `${message} (${cause})` : message;
}
