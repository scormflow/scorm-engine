import { describe, expect, it, vi } from 'vitest';

import { WebhookDispatcher } from '../../src/webhooks/dispatcher.js';
import { verifySignature } from '../../src/webhooks/signing.js';
import { createMockLrs } from '../helpers/mock-lrs.js';

const TENANT = 'tenant_test';

function setup(responses: Array<number | Error> = [200]) {
  const lrs = createMockLrs({ tenantId: TENANT });
  let clock = new Date('2026-10-05T12:00:00Z');
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let call = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(call++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return new Response(next === 200 ? 'ok' : 'nope', { status: next });
  });
  const dispatcher = new WebhookDispatcher({
    prisma: lrs.prisma,
    maxAttempts: 3,
    retryBaseSeconds: 30,
    timeoutMs: 1000,
    fetch: fetchMock as unknown as typeof fetch,
    now: () => clock,
  });
  const endpoint = (over: Record<string, unknown> = {}) =>
    lrs.prisma.webhookEndpoint.create({
      data: {
        tenantId: TENANT,
        url: 'https://hooks.example.com/in',
        events: ['course.completed'],
        secret: 'whsec_test',
        ...over,
      } as any,
    });
  return {
    lrs,
    dispatcher,
    fetchMock,
    requests,
    endpoint,
    advance: (seconds: number) => {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
    now: () => clock,
  };
}

describe('WebhookDispatcher', () => {
  it('delivers a signed event to subscribed, enabled endpoints only', async () => {
    const t = setup();
    const sub = await t.endpoint();
    await t.endpoint({ events: ['*'] });
    await t.endpoint({ events: ['score.updated'] });
    await t.endpoint({ enabled: false });
    await t.endpoint({ tenantId: 'other' });

    const ids = await t.dispatcher.publish(TENANT, 'course.completed', { attemptId: 'a1' });
    expect(ids).toHaveLength(2);
    expect(t.fetchMock).toHaveBeenCalledTimes(2);

    const req = t.requests[0]!;
    const headers = req.init.headers as Record<string, string>;
    const body = req.init.body as string;
    expect(req.url).toBe('https://hooks.example.com/in');
    expect(headers['ScormFlow-Event']).toBe('course.completed');
    expect(verifySignature('whsec_test', headers['ScormFlow-Signature'], body, { now: t.now() })).toBe(true);
    expect(req.init.redirect).toBe('manual');

    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ type: 'course.completed', data: { attemptId: 'a1' } });
    expect(payload.id).toMatch(/^evt_/);
    // Both endpoints get the same event id, so receivers can dedupe.
    expect(JSON.parse(t.requests[1]!.init.body as string).id).toBe(payload.id);

    const delivery = t.lrs.webhooks.deliveries.find((d) => d.endpointId === sub.id)!;
    expect(delivery).toMatchObject({ status: 'SUCCEEDED', attempts: 1, lastStatusCode: 200, nextAttemptAt: null });
    expect(delivery.deliveredAt).toBeInstanceOf(Date);
  });

  it('retries with exponential backoff, then parks the delivery as FAILED', async () => {
    const t = setup([500, new Error('fetch failed'), 503]);
    await t.endpoint();
    const [id] = await t.dispatcher.publish(TENANT, 'course.completed', {});
    const row = () => t.lrs.webhooks.deliveries.find((d) => d.id === id)!;

    expect(row()).toMatchObject({ status: 'PENDING', attempts: 1, lastStatusCode: 500, lastResponse: 'nope' });
    expect(row().nextAttemptAt.getTime() - t.now().getTime()).toBe(30_000);

    // Not due yet: the poller leaves it alone.
    expect(await t.dispatcher.processDue()).toBe(0);

    t.advance(30);
    expect(await t.dispatcher.processDue()).toBe(1);
    expect(row()).toMatchObject({ status: 'PENDING', attempts: 2, lastStatusCode: null, lastError: 'fetch failed' });
    expect(row().nextAttemptAt.getTime() - t.now().getTime()).toBe(60_000);

    t.advance(60);
    await t.dispatcher.processDue();
    expect(row()).toMatchObject({ status: 'FAILED', attempts: 3, lastStatusCode: 503, nextAttemptAt: null });
    expect(t.fetchMock).toHaveBeenCalledTimes(3);

    t.advance(3600);
    expect(await t.dispatcher.processDue()).toBe(0);
  });

  it('redelivers a dead-lettered delivery once on request', async () => {
    const t = setup([500, 500, 500, 200]);
    await t.endpoint();
    const [id] = await t.dispatcher.publish(TENANT, 'course.completed', {});
    const row = () => t.lrs.webhooks.deliveries.find((d) => d.id === id)!;
    t.advance(30);
    await t.dispatcher.processDue();
    t.advance(60);
    await t.dispatcher.processDue();
    expect(row().status).toBe('FAILED');

    await t.dispatcher.redeliver(id!);
    expect(row()).toMatchObject({ status: 'SUCCEEDED', attempts: 4 });
  });

  it('fails a manual retry straight back to FAILED instead of rescheduling it', async () => {
    const t = setup([500]);
    await t.endpoint();
    const [id] = await t.dispatcher.publish(TENANT, 'course.completed', {});
    await t.dispatcher.redeliver(id!);
    expect(t.lrs.webhooks.deliveries[0]).toMatchObject({ status: 'FAILED', attempts: 2 });
  });

  it('never sends one delivery twice when two workers race for it', async () => {
    const t = setup([500, 200]);
    await t.endpoint();
    await t.dispatcher.publish(TENANT, 'course.completed', {});
    t.advance(30);
    await Promise.all([t.dispatcher.processDue(), t.dispatcher.processDue()]);
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a redirect as a failure', async () => {
    const t = setup([302]);
    await t.endpoint();
    await t.dispatcher.publish(TENANT, 'course.completed', {});
    expect(t.lrs.webhooks.deliveries[0]).toMatchObject({ status: 'PENDING', lastError: 'Receiver answered HTTP 302' });
  });

  it('emit is fire-and-forget and idle() waits for it', async () => {
    const t = setup();
    await t.endpoint();
    t.dispatcher.emit(TENANT, 'course.completed', {});
    await t.dispatcher.idle();
    expect(t.lrs.webhooks.deliveries[0]!.status).toBe('SUCCEEDED');
  });

  it('enqueue keeps the bus event id, attempts in the background, and never double-queues a redelivery', async () => {
    const t = setup();
    await t.endpoint();
    await t.endpoint({ events: ['*'] });
    await t.endpoint({ events: ['score.updated'] });
    const event = {
      id: 'evt_bus-1',
      tenantId: TENANT,
      type: 'course.completed' as const,
      createdAt: '2026-10-13T09:00:00.000Z',
      data: { attemptId: 'a1' },
    };

    const ids = await t.dispatcher.enqueue(event);
    expect(ids).toHaveLength(2);
    await t.dispatcher.idle();
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    for (const req of t.requests) {
      expect(JSON.parse(req.init.body as string)).toEqual({
        id: 'evt_bus-1',
        type: 'course.completed',
        createdAt: '2026-10-13T09:00:00.000Z',
        data: { attemptId: 'a1' },
      });
    }

    // A transport retry of the same event, after one more endpoint subscribed.
    const late = await t.endpoint({ events: ['*'] });
    const again = await t.dispatcher.enqueue(event);
    await t.dispatcher.idle();
    expect(again).toHaveLength(1);
    expect(t.lrs.webhooks.deliveries.filter((d) => d.eventId === 'evt_bus-1')).toHaveLength(3);
    expect(t.lrs.webhooks.deliveries.at(-1)!.endpointId).toBe(late.id);
  });

  it('caps the backoff at six hours', () => {
    const { dispatcher } = setup();
    expect(dispatcher.backoffSeconds(1)).toBe(30);
    expect(dispatcher.backoffSeconds(4)).toBe(240);
    expect(dispatcher.backoffSeconds(30)).toBe(6 * 60 * 60);
  });
});
