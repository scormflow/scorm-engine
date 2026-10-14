import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import { ActivityCounter, analyticsPlugin } from '../../src/plugins/index.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMockLrs, type MockLrs } from '../helpers/mock-lrs.js';

const T0 = Date.parse('2026-10-14T10:00:30.000Z');

describe('ActivityCounter', () => {
  it('buckets per minute, fills empty minutes and keeps tenants apart', () => {
    let now = T0;
    const counter = new ActivityCounter(5, () => new Date(now));
    counter.record({ tenantId: 'a', type: 'attempt.started' });
    counter.record({ tenantId: 'a', type: 'attempt.started' });
    counter.record({ tenantId: 'b', type: 'attempt.started' });
    now += 2 * 60_000;
    counter.record({ tenantId: 'a', type: 'course.completed' });

    const report = counter.report('a', 3);
    expect(report).toMatchObject({
      windowMinutes: 3,
      since: '2026-10-14T10:00:00.000Z',
      total: 3,
      totals: { 'attempt.started': 2, 'course.completed': 1 },
    });
    expect(report.timeline).toEqual([
      { minute: '2026-10-14T10:00:00.000Z', total: 2, counts: { 'attempt.started': 2 } },
      { minute: '2026-10-14T10:01:00.000Z', total: 0, counts: {} },
      { minute: '2026-10-14T10:02:00.000Z', total: 1, counts: { 'course.completed': 1 } },
    ]);
    expect(counter.report('b', 3).total).toBe(1);
    expect(counter.report('nobody', 3)).toMatchObject({ total: 0, totals: {} });
  });

  it('drops minutes older than the retention window and caps the window at it', () => {
    let now = T0;
    const counter = new ActivityCounter(2, () => new Date(now));
    counter.record({ tenantId: 'a', type: 'score.updated' });
    now += 5 * 60_000;
    counter.record({ tenantId: 'a', type: 'score.updated' });
    const report = counter.report('a', 60);
    expect(report.windowMinutes).toBe(2);
    expect(report.timeline).toHaveLength(2);
    expect(report.total).toBe(1);
  });
});

describe('analyticsPlugin', () => {
  let app: FastifyInstance;
  let lrs: MockLrs;
  let now: number;

  async function build(retentionMinutes?: number) {
    lrs = createMockLrs();
    now = T0;
    app = await buildApp({
      env: createTestEnv(),
      prisma: lrs.prisma,
      storage: new MemoryStorage(),
      plugins: [analyticsPlugin({ now: () => new Date(now), ...(retentionMinutes ? { retentionMinutes } : {}) })],
    });
    await app.ready();
  }

  afterEach(async () => {
    await app.close();
  });

  const activity = (query = '') =>
    app.inject({
      method: 'GET',
      url: `/api/v1/plugins/analytics/activity${query}`,
      headers: { 'x-api-key': lrs.apiKey },
    });

  it("reports the tenant's recent events, ignoring other tenants and test webhooks", async () => {
    await build(10);
    app.events.emit(lrs.tenantId, 'attempt.started', { attemptId: 'a1' });
    app.events.emit(lrs.tenantId, 'course.completed', { attemptId: 'a1' });
    app.events.emit(lrs.tenantId, 'webhook.test', {});
    app.events.emit('someone_else', 'attempt.started', {});
    await app.events.idle();

    const res = await activity('?minutes=5');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      windowMinutes: 5,
      total: 2,
      totals: { 'attempt.started': 1, 'course.completed': 1 },
    });
    expect(body.timeline).toHaveLength(5);
    expect(body.timeline.at(-1)).toEqual({
      minute: '2026-10-14T10:00:00.000Z',
      total: 2,
      counts: { 'attempt.started': 1, 'course.completed': 1 },
    });

    expect((await activity()).json().windowMinutes).toBe(10);
  });

  it('validates ?minutes= and requires an API key', async () => {
    await build(10);
    for (const bad of ['0', '11', '2.5', 'abc']) {
      const res = await activity(`?minutes=${bad}`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_request' });
    }
    const anon = await app.inject({ method: 'GET', url: '/api/v1/plugins/analytics/activity' });
    expect(anon.statusCode).toBe(401);
  });

  it('rejects an out-of-range retention up front', () => {
    expect(() => analyticsPlugin({ retentionMinutes: 0 })).toThrow(RangeError);
    expect(() => analyticsPlugin({ retentionMinutes: 1441 })).toThrow(RangeError);
    app = { close: async () => undefined } as unknown as FastifyInstance;
  });
});
