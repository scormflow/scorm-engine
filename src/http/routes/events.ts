import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ServerResponse } from 'node:http';

import type { EngineEvent, EventBus } from '../../events/index.js';
import { isWebhookEventType, type WebhookEventType, type WebhookPayload } from '../../webhooks/index.js';

export interface EventRouteDeps {
  bus: EventBus;
  /** Seconds between keep-alive comments on an idle stream. */
  heartbeatSeconds: number;
}

/** A client that stops reading gets cut off once this much is buffered for it. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * The live event stream, mounted under `/events`.
 *
 * `GET /events/stream` is a Server-Sent Events feed of the tenant's engine
 * events, as they happen — the same envelope a webhook receives, without the
 * public endpoint. Events are not replayed: a client that reconnects picks up
 * from then on (webhooks are the durable channel). Each message carries the
 * event id, so a client that also consumes webhooks can dedupe.
 */
export function eventRoutes(deps: EventRouteDeps): FastifyPluginAsync {
  const { bus } = deps;
  const heartbeatMs = deps.heartbeatSeconds * 1000;

  return async function (app: FastifyInstance): Promise<void> {
    const open = new Set<ServerResponse>();
    // Open streams would otherwise hold `app.close()` until clients hang up.
    app.addHook('preClose', async () => {
      for (const res of open) res.end();
    });

    app.get<{ Querystring: { types?: string } }>(
      '/stream',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const types = parseTypes(req.query.types);
        if (types === null) {
          return reply.code(400).send({
            code: 'invalid_events',
            message: 'types must be a comma-separated list of event types',
          });
        }

        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          ...(reply.getHeaders() as Record<string, string>),
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          // Stops nginx from buffering the stream.
          'x-accel-buffering': 'no',
        });
        res.write(`retry: 3000\n: connected\n\n`);
        open.add(res);

        const send = (chunk: string) => {
          if (res.writableEnded) return;
          if (res.writableLength > MAX_BUFFERED_BYTES) {
            req.log.warn({ tenantId: req.tenantId }, 'event stream client too slow; closing');
            res.end();
            return;
          }
          res.write(chunk);
        };

        const unlisten = bus.listen((event) => send(formatEvent(event)), {
          tenantId: req.tenantId,
          ...(types ? { types } : {}),
        });
        const heartbeat = setInterval(() => send(': ping\n\n'), heartbeatMs);
        heartbeat.unref();

        res.on('close', () => {
          clearInterval(heartbeat);
          unlisten();
          open.delete(res);
        });
      },
    );
  };
}

/** One SSE message: the webhook payload, named by event type. */
export function formatEvent(event: EngineEvent): string {
  const payload: WebhookPayload = { id: event.id, type: event.type, createdAt: event.createdAt, data: event.data };
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** `undefined` for every type, `null` when the list names an unknown type. */
function parseTypes(raw: string | undefined): WebhookEventType[] | undefined | null {
  if (raw === undefined || raw.trim() === '' || raw.trim() === '*') return undefined;
  const types = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return types.every(isWebhookEventType) ? types : null;
}
