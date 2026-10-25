import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventBus, RedisStreamsTransport, type EngineEvent } from '../../src/events/index.js';
import { FakeRedis } from '../helpers/fake-redis.js';

const STREAM = 'test:events';
const GROUP = 'engine';

function transport(redis: FakeRedis, consumer: string, over: Partial<ConstructorParameters<typeof RedisStreamsTransport>[0]> = {}) {
  return new RedisStreamsTransport({
    connect: redis.connect,
    stream: STREAM,
    group: GROUP,
    consumer,
    blockMs: 10,
    claimIdleMs: 1_000,
    maxDeliveries: 3,
    reconnectDelayMs: 5,
    ...over,
  });
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('RedisStreamsTransport', () => {
  const buses: EventBus[] = [];
  afterEach(async () => {
    await Promise.all(buses.splice(0).map((b) => b.close()));
  });

  function bus(redis: FakeRedis, consumer: string, over = {}) {
    const b = new EventBus({ transport: transport(redis, consumer, over), logger: { warn: vi.fn(), error: vi.fn() } });
    buses.push(b);
    return b;
  }

  it('appends each event to the stream as JSON, capped by MAXLEN', async () => {
    const redis = new FakeRedis();
    const b = bus(redis, 'c1', { maxLength: 5000 });
    const event = await b.publish('t1', 'course.completed', { attemptId: 'a1' });
    const xadd = redis.log.find((c) => c[0] === 'XADD')!;
    expect(xadd.slice(0, 6)).toEqual(['XADD', STREAM, 'MAXLEN', '~', '5000', '*']);
    expect(JSON.parse(redis.entries(STREAM)[0]!.fields[1]!)).toEqual(event);
    expect(b.driver).toBe('redis');
  });

  it('gives each event to one instance of the group, and broadcasts it to all', async () => {
    const redis = new FakeRedis();
    const a = bus(redis, 'a');
    const b = bus(redis, 'b');
    const work: string[] = [];
    const seen: string[] = [];
    for (const [name, x] of [['a', a], ['b', b]] as const) {
      x.subscribe('work', (e) => void work.push(`${name}:${e.data.n}`));
      x.listen((e) => void seen.push(`${name}:${e.data.n}`));
    }
    await a.start();
    await b.start();

    for (let n = 1; n <= 4; n++) await (n % 2 ? a : b).publish('t1', 'score.updated', { n });

    await until(() => work.length === 4 && seen.length === 8);
    expect(work.map((w) => w.split(':')[1]).sort()).toEqual(['1', '2', '3', '4']);
    expect(seen.filter((s) => s.startsWith('a:'))).toHaveLength(4);
    expect(seen.filter((s) => s.startsWith('b:'))).toHaveLength(4);
    await until(() => redis.pending(STREAM, GROUP).size === 0);
  });

  it('ignores entries published before the instance started, for broadcast', async () => {
    const redis = new FakeRedis();
    const early = bus(redis, 'early');
    await early.start();
    await early.publish('t1', 'course.completed', { n: 'old' });

    const late = bus(redis, 'late');
    const seen: unknown[] = [];
    late.listen((e) => void seen.push(e.data.n));
    await late.start();
    await late.publish('t1', 'course.completed', { n: 'new' });
    await until(() => seen.length === 1);
    expect(seen).toEqual(['new']);
  });

  it('retries a failed event once it has been idle, then dead-letters it', async () => {
    const redis = new FakeRedis();
    const b = bus(redis, 'c1');
    const attempts: string[] = [];
    b.subscribe('flaky', (e: EngineEvent) => {
      attempts.push(e.id);
      throw new Error('downstream down');
    });
    await b.start();
    const event = await b.publish('t1', 'course.completed', {});

    await until(() => attempts.length === 1);
    expect(redis.pending(STREAM, GROUP).get(redis.entries(STREAM)[0]!.id)?.deliveries).toBe(1);

    // Not idle long enough yet: no retry.
    await new Promise((r) => setTimeout(r, 40));
    expect(attempts).toHaveLength(1);

    redis.advance(1_000);
    await until(() => attempts.length === 2);
    redis.advance(1_000);
    await until(() => attempts.length === 3);
    redis.advance(1_000);
    await until(() => redis.entries(`${STREAM}:dead`).length === 1);

    expect(attempts).toEqual([event.id, event.id, event.id]);
    expect(redis.pending(STREAM, GROUP).size).toBe(0);
    const dead = redis.entries(`${STREAM}:dead`)[0]!.fields;
    expect(JSON.parse(dead[1]!)).toMatchObject({ id: event.id });
    expect(dead.slice(2)).toEqual(['sourceId', redis.entries(STREAM)[0]!.id, 'deliveries', '3']);
  });

  it('acknowledges and skips entries it cannot read', async () => {
    const redis = new FakeRedis();
    const b = bus(redis, 'c1');
    const work = vi.fn();
    b.subscribe('w', work);
    await b.start();
    const conn = await redis.connect();
    await conn.send(['XADD', STREAM, '*', 'event', '{not json']);
    await conn.send(['XADD', STREAM, '*', 'event', JSON.stringify({ id: 'x', tenantId: 't', type: 'nope', createdAt: '', data: {} })]);
    await b.publish('t1', 'course.completed', {});
    await until(() => work.mock.calls.length === 1);
    await until(() => redis.pending(STREAM, GROUP).size === 0);
  });

  it('keeps the existing group when a second instance starts', async () => {
    const redis = new FakeRedis();
    await bus(redis, 'a').start();
    await expect(bus(redis, 'b').start()).resolves.toBeUndefined();
  });

  it('closes its connections, ending blocked reads', async () => {
    const redis = new FakeRedis();
    const b = new EventBus({ transport: transport(redis, 'c1', { blockMs: 60_000 }) });
    b.subscribe('w', () => undefined);
    b.listen(() => undefined);
    await b.start();
    await until(() => redis.log.filter((c) => c[0] === 'XREAD' || c[0] === 'XREADGROUP').length >= 2);
    const started = Date.now();
    await b.close();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
