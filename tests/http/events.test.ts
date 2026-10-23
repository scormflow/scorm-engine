import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import { WebhookDispatcher } from '../../src/webhooks/index.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMockLrs, type MockLrs } from '../helpers/mock-lrs.js';

const STREAM = '/api/v1/events/stream';

let app: FastifyInstance;
let lrs: MockLrs;
let base: string;
let hooks: Array<{ id: string; type: string }>;

beforeEach(async () => {
  lrs = createMockLrs();
  hooks = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    hooks.push(JSON.parse(init!.body as string));
    return new Response('ok');
  });
  const webhooks = new WebhookDispatcher({
    prisma: lrs.prisma,
    maxAttempts: 3,
    retryBaseSeconds: 30,
    timeoutMs: 1000,
    fetch: fetchMock as unknown as typeof fetch,
  });
  app = await buildApp({
    env: createTestEnv({ EVENT_STREAM_HEARTBEAT_SECONDS: 1 }),
    prisma: lrs.prisma,
    storage: new MemoryStorage(),
    webhooks,
  });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await app.close();
});

interface SseMessage {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** Open the stream and collect parsed messages as they arrive. */
async function open(query = '', headers: Record<string, string> = { 'x-api-key': lrs.apiKey }) {
  const controller = new AbortController();
  const res = await fetch(`${base}${STREAM}${query}`, { headers, signal: controller.signal });
  const messages: SseMessage[] = [];
  let done = false;
  if (res.ok) {
    void (async () => {
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += value;
          let at: number;
          while ((at = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, at);
            buf = buf.slice(at + 2);
            const msg: SseMessage = {};
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) msg.comment = line.slice(1).trim();
              else {
                const i = line.indexOf(':');
                const field = line.slice(0, i) as keyof SseMessage;
                if (field === 'id' || field === 'event' || field === 'data') msg[field] = line.slice(i + 1).trim();
              }
            }
            messages.push(msg);
          }
        }
      } catch {
        // aborted
      }
      done = true;
    })();
  }
  return { res, messages, close: () => controller.abort(), ended: () => done };
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const events = (msgs: SseMessage[]) => msgs.filter((m) => m.event);

describe('GET /events/stream', () => {
  it('requires an API key', async () => {
    const { res } = await open('', {});
    expect(res.status).toBe(401);
  });

  it('rejects unknown event types', async () => {
    const { res } = await open('?types=course.completed,nope');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_events' });
  });

  it("streams the tenant's events as SSE with the webhook envelope, and nobody else's", async () => {
    const stream = await open();
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(stream.res.headers.get('cache-control')).toContain('no-cache');
    await until(() => stream.messages.some((m) => m.comment === 'connected'));

    app.events.emit('someone_else', 'course.completed', { attemptId: 'theirs' });
    const published = await app.events.publish(lrs.tenantId, 'course.completed', { attemptId: 'a1' });

    await until(() => events(stream.messages).length === 1);
    const [msg] = events(stream.messages);
    expect(msg).toMatchObject({ id: published.id, event: 'course.completed' });
    expect(JSON.parse(msg!.data!)).toEqual({
      id: published.id,
      type: 'course.completed',
      createdAt: published.createdAt,
      data: { attemptId: 'a1' },
    });
    stream.close();
  });

  it('filters by ?types=', async () => {
    const stream = await open('?types=score.updated, course.passed');
    await until(() => stream.messages.length > 0);
    app.events.emit(lrs.tenantId, 'course.completed', {});
    app.events.emit(lrs.tenantId, 'course.passed', {});
    app.events.emit(lrs.tenantId, 'score.updated', {});
    await until(() => events(stream.messages).length === 2);
    expect(events(stream.messages).map((m) => m.event)).toEqual(['course.passed', 'score.updated']);
    stream.close();
  });

  it('sends heartbeats on an idle stream', async () => {
    const stream = await open();
    await until(() => stream.messages.some((m) => m.comment === 'ping'), 3_000);
    stream.close();
  });

  it('carries the same event id to the stream and to webhooks', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: { 'x-api-key': lrs.apiKey },
      payload: { url: 'https://hooks.example.com/in', events: ['*'] },
    });
    const stream = await open();
    await until(() => stream.messages.length > 0);
    const published = await app.events.publish(lrs.tenantId, 'certificate.issued', { serial: 'X' });
    await until(() => hooks.length === 1 && events(stream.messages).length === 1);
    expect(hooks[0]!.id).toBe(published.id);
    expect(events(stream.messages)[0]!.id).toBe(published.id);
    stream.close();
  });

  it('stops listening when the client disconnects, and app.close ends open streams', async () => {
    const original = app.events.listen.bind(app.events);
    const unlistened = vi.fn();
    vi.spyOn(app.events, 'listen').mockImplementation((handler, options) => {
      const off = original(handler, options);
      return () => {
        unlistened();
        off();
      };
    });
    const gone = await open();
    await until(() => gone.messages.length > 0);
    expect(unlistened).not.toHaveBeenCalled();
    gone.close();
    await until(() => unlistened.mock.calls.length === 1);

    const stays = await open();
    await until(() => stays.messages.length > 0);
    await app.close();
    await until(() => stays.ended());
  });
});
