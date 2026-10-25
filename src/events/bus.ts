import { randomUUID } from 'node:crypto';

import type { EventSink, WebhookEventType } from '../webhooks/events.js';
import { MemoryTransport } from './memory.js';
import type { EngineEvent, EventBusLogger, EventHandler, EventTransport } from './types.js';

/**
 * The engine's event bus.
 *
 * Services raise events through the {@link EventSink} interface they already
 * use (`emit(tenantId, type, data)`); the bus stamps an id and timestamp and
 * hands the event to its transport. On the other side sit two kinds of
 * receivers:
 *
 *  - **subscribers** (`subscribe`) do work — enqueue webhooks, issue things —
 *    and run on exactly one instance per event when the transport is shared;
 *  - **listeners** (`listen`) observe — the live event stream, metrics — and
 *    run on every instance.
 *
 * Publishing never throws at the caller and never waits for handlers: what a
 * receiver does with an event is not allowed to fail the request that raised it.
 */

export interface EventBusOptions {
  /** Where events travel. Defaults to an in-process {@link MemoryTransport}. */
  transport?: EventTransport;
  logger?: EventBusLogger;
  now?: () => Date;
}

export interface SubscribeOptions {
  /** Only these event types; every type when omitted. */
  types?: readonly WebhookEventType[];
}

export interface ListenOptions extends SubscribeOptions {
  /** Only this tenant's events; every tenant when omitted. */
  tenantId?: string;
}

interface Subscriber {
  name: string;
  handler: EventHandler;
  types: ReadonlySet<string> | undefined;
}

interface Listener {
  handler: EventHandler;
  types: ReadonlySet<string> | undefined;
  tenantId: string | undefined;
}

export class EventBus implements EventSink {
  readonly transport: EventTransport;
  private readonly logger: EventBusLogger | undefined;
  private readonly now: () => Date;
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Set<Promise<unknown>>();
  private started = false;
  private closed = false;

  constructor(options: EventBusOptions = {}) {
    this.transport = options.transport ?? new MemoryTransport();
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.transport.consume((event) => this.runSubscribers(event));
    this.transport.broadcast((event) => this.runListeners(event));
  }

  /** The transport's driver name (`memory`, `redis`). */
  get driver(): string {
    return this.transport.name;
  }

  emit(tenantId: string, type: WebhookEventType, data: Record<string, unknown>): void {
    this.track(
      this.publish(tenantId, type, data).catch((err: unknown) => {
        this.logger?.error({ err, tenantId, type }, 'event publish failed');
      }),
    );
  }

  /** Publish an event and resolve with it once the transport has accepted it. */
  async publish(tenantId: string, type: WebhookEventType, data: Record<string, unknown>): Promise<EngineEvent> {
    const event: EngineEvent = {
      id: `evt_${randomUUID()}`,
      tenantId,
      type,
      createdAt: this.now().toISOString(),
      data,
    };
    if (this.closed) throw new Error('Event bus is closed');
    await this.transport.publish(event);
    return event;
  }

  /**
   * Register a named work handler. Names are unique: registering the same name
   * again replaces the handler. A handler that rejects is logged and, on a
   * transport that can retry, the event is redelivered — so handlers should be
   * idempotent on `event.id`. Returns an unsubscribe function.
   */
  subscribe(name: string, handler: EventHandler, options: SubscribeOptions = {}): () => void {
    const sub: Subscriber = { name, handler, types: options.types ? new Set(options.types) : undefined };
    this.subscribers.set(name, sub);
    return () => {
      if (this.subscribers.get(name) === sub) this.subscribers.delete(name);
    };
  }

  /** Observe every matching event published anywhere on the transport. Returns an unsubscribe function. */
  listen(handler: EventHandler, options: ListenOptions = {}): () => void {
    const listener: Listener = {
      handler,
      types: options.types ? new Set(options.types) : undefined,
      tenantId: options.tenantId,
    };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Start the transport's receive loops. Safe to call more than once. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.transport.start();
  }

  /** Stop receiving, wait for in-flight handlers and close the transport. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.idle();
    await this.transport.close();
    this.listeners.clear();
  }

  /** Resolves once every publish and handler started so far has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  // ---- internals -----------------------------------------------------------

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }

  private runSubscribers(event: EngineEvent): Promise<void> {
    const runs: Promise<boolean>[] = [];
    for (const sub of this.subscribers.values()) {
      if (sub.types && !sub.types.has(event.type)) continue;
      runs.push(
        invoke(sub.handler, event).then(
          () => true,
          (err: unknown) => {
            this.logger?.error(
              { err, subscriber: sub.name, eventId: event.id, type: event.type },
              'event subscriber failed',
            );
            return false;
          },
        ),
      );
    }
    const done = Promise.all(runs).then((results) => {
      const failed = results.filter((ok) => !ok).length;
      if (failed > 0) throw new Error(`${failed} event subscriber(s) failed for ${event.id}`);
    });
    this.track(done.catch(() => undefined));
    return done;
  }

  private runListeners(event: EngineEvent): void {
    for (const listener of this.listeners) {
      if (listener.tenantId !== undefined && listener.tenantId !== event.tenantId) continue;
      if (listener.types && !listener.types.has(event.type)) continue;
      this.track(
        invoke(listener.handler, event).catch((err: unknown) => {
          this.logger?.warn({ err, eventId: event.id, type: event.type }, 'event listener failed');
        }),
      );
    }
  }
}

/** Call a handler and turn a synchronous throw into a rejection. */
function invoke(handler: EventHandler, event: EngineEvent): Promise<void> {
  try {
    return Promise.resolve(handler(event));
  } catch (err) {
    return Promise.reject(err);
  }
}
