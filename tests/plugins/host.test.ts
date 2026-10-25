import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp, type AppDeps } from '../../src/http/app.js';
import { TenantRateLimiter } from '../../src/http/rate-limit.js';
import { definePlugin, PluginError, type PluginContext, type ScormflowPlugin } from '../../src/plugins/index.js';
import { EventBus, type EngineEvent } from '../../src/events/index.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMockLrs, type MockLrs } from '../helpers/mock-lrs.js';

let app: FastifyInstance | undefined;
let lrs: MockLrs;

async function build(plugins: ScormflowPlugin[] | undefined, extra: Partial<AppDeps> = {}) {
  lrs = createMockLrs();
  app = await buildApp({
    env: createTestEnv(),
    prisma: lrs.prisma,
    storage: new MemoryStorage(),
    ...extra,
    ...(plugins ? { plugins } : {}),
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const key = () => ({ 'x-api-key': lrs.apiKey });

describe('plugin system', () => {
  it('hands setup the engine context and lists installed plugins', async () => {
    let seen: PluginContext | undefined;
    const a = await build([
      definePlugin({ name: 'first', version: '2.1.0', setup: (ctx) => void (seen = ctx) }),
      definePlugin({ name: 'second', setup: () => undefined }),
    ]);
    expect(seen?.name).toBe('first');
    expect(seen?.events).toBe(a.events);
    expect(seen?.prisma).toBe(lrs.prisma);

    const res = await a.inject({ method: 'GET', url: '/api/v1/plugins', headers: key() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [
        { name: 'first', version: '2.1.0' },
        { name: 'second', version: null },
      ],
    });
    expect((await a.inject({ method: 'GET', url: '/api/v1/plugins' })).statusCode).toBe(401);
  });

  it('installs the built-ins PLUGINS names when no list is passed, and none for []', async () => {
    const withEnv = await build(undefined, { env: createTestEnv({ PLUGINS: ['analytics'] }) });
    const listed = await withEnv.inject({ method: 'GET', url: '/api/v1/plugins', headers: key() });
    expect(listed.json().data.map((p: { name: string }) => p.name)).toEqual(['analytics']);
    await withEnv.close();

    const none = await build([], { env: createTestEnv({ PLUGINS: ['analytics'] }) });
    const empty = await none.inject({ method: 'GET', url: '/api/v1/plugins', headers: key() });
    expect(empty.json()).toEqual({ data: [] });
  });

  it('mounts plugin routes under /plugins/<name> behind the API key', async () => {
    const a = await build([
      definePlugin({
        name: 'hello',
        setup(ctx) {
          ctx.routes((r) => {
            r.get('/greeting', async (req) => ({ tenantId: req.tenantId, from: ctx.name }));
          });
        },
      }),
    ]);
    expect((await a.inject({ method: 'GET', url: '/api/v1/plugins/hello/greeting' })).statusCode).toBe(401);
    const ok = await a.inject({ method: 'GET', url: '/api/v1/plugins/hello/greeting', headers: key() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ tenantId: lrs.tenantId, from: 'hello' });
  });

  it("runs a route's own preHandlers after the guard, and applies the tenant rate limit", async () => {
    const order: string[] = [];
    const a = await build(
      [
        definePlugin({
          name: 'limited',
          setup(ctx) {
            ctx.routes((r) => {
              r.get('/bare', async () => ({ ok: true }));
              r.get(
                '/guarded',
                {
                  preHandler: async (req) => {
                    order.push(`own:${req.tenantId}`);
                  },
                },
                async () => ({ ok: true }),
              );
            });
          },
        }),
      ],
      { rateLimiter: new TenantRateLimiter({ max: 2, windowSeconds: 60 }) },
    );

    const bare1 = await a.inject({ method: 'GET', url: '/api/v1/plugins/limited/bare', headers: key() });
    expect(bare1.headers['x-ratelimit-limit']).toBe('2');
    const guarded = await a.inject({ method: 'GET', url: '/api/v1/plugins/limited/guarded', headers: key() });
    expect(guarded.statusCode).toBe(200);
    expect(order).toEqual([`own:${lrs.tenantId}`]);
    const third = await a.inject({ method: 'GET', url: '/api/v1/plugins/limited/bare', headers: key() });
    expect(third.statusCode).toBe(429);
  });

  it('namespaces subscribers, delivers events to subscribe and listen, and closes in reverse order', async () => {
    const got: Array<[string, EngineEvent['type']]> = [];
    const closed: string[] = [];
    const make = (name: string) =>
      definePlugin({
        name,
        setup(ctx) {
          ctx.subscribe('work', (e) => void got.push([`${name}:sub`, e.type]), { types: ['course.completed'] });
          ctx.listen((e) => void got.push([`${name}:listen`, e.type]));
          ctx.onClose(() => void closed.push(name));
        },
      });
    const bus = new EventBus();
    const subscribe = vi.spyOn(bus, 'subscribe');
    const a = await build([make('one'), make('two')], { eventBus: bus });
    expect(subscribe.mock.calls.map(([name]) => name)).toEqual(['webhooks', 'plugin:one:work', 'plugin:two:work']);

    a.events.emit(lrs.tenantId, 'course.completed', {});
    a.events.emit(lrs.tenantId, 'score.updated', {});
    await a.events.idle();
    expect(got).toEqual(
      expect.arrayContaining([
        ['one:sub', 'course.completed'],
        ['two:sub', 'course.completed'],
        ['one:listen', 'course.completed'],
        ['one:listen', 'score.updated'],
        ['two:listen', 'score.updated'],
      ]),
    );
    expect(got.filter(([who]) => who.endsWith(':sub'))).toHaveLength(2);

    await a.close();
    app = undefined;
    expect(closed).toEqual(['two', 'one']);
  });

  it('keeps closing when a closer throws', async () => {
    const closed: string[] = [];
    const a = await build([
      definePlugin({ name: 'ok', setup: (ctx) => ctx.onClose(() => void closed.push('ok')) }),
      definePlugin({
        name: 'broken',
        setup: (ctx) =>
          ctx.onClose(() => {
            throw new Error('boom');
          }),
      }),
    ]);
    await a.close();
    app = undefined;
    expect(closed).toEqual(['ok']);
  });

  it('rejects bad names, duplicates and failing setups', async () => {
    await expect(build([definePlugin({ name: 'Bad Name', setup: () => undefined })])).rejects.toThrow(
      /Invalid plugin name/,
    );
    await expect(
      build([
        definePlugin({ name: 'twice', setup: () => undefined }),
        definePlugin({ name: 'twice', setup: () => undefined }),
      ]),
    ).rejects.toThrow(/installed twice/);

    const failure = build([
      definePlugin({
        name: 'explodes',
        setup: async () => {
          throw new Error('no database');
        },
      }),
    ]);
    await expect(failure).rejects.toBeInstanceOf(PluginError);
    await expect(failure).rejects.toThrow('Plugin "explodes" failed to set up: no database');
  });

  it('refuses routes registered after setup', async () => {
    let late: PluginContext | undefined;
    await build([definePlugin({ name: 'late', setup: (ctx) => void (late = ctx) })]);
    expect(() => late!.routes(() => undefined)).toThrow(/after setup/);
  });
});
