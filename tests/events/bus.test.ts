import { describe, expect, it, vi } from 'vitest';

import { EventBus, MemoryTransport, type EngineEvent } from '../../src/events/index.js';

function logger() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe('EventBus (memory transport)', () => {
  it('stamps an id and timestamp and delivers to subscribers before emit returns', () => {
    const now = new Date('2026-10-13T10:00:00Z');
    const bus = new EventBus({ now: () => now });
    const seen: EngineEvent[] = [];
    bus.subscribe('spy', (e) => {
      seen.push(e);
    });

    bus.emit('t1', 'course.completed', { attemptId: 'a1' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tenantId: 't1',
      type: 'course.completed',
      createdAt: '2026-10-13T10:00:00.000Z',
      data: { attemptId: 'a1' },
    });
    expect(seen[0]!.id).toMatch(/^evt_[0-9a-f-]{36}$/);
    expect(bus.driver).toBe('memory');
  });

  it('gives subscribers and listeners the same event id', async () => {
    const bus = new EventBus();
    const ids: string[] = [];
    bus.subscribe('a', (e) => void ids.push(e.id));
    bus.listen((e) => void ids.push(e.id));
    const event = await bus.publish('t1', 'score.updated', {});
    expect(ids).toEqual([event.id, event.id]);
  });

  it('filters subscribers by type and listeners by tenant and type', async () => {
    const bus = new EventBus();
    const sub: string[] = [];
    const tenantOnly: string[] = [];
    const typed: string[] = [];
    bus.subscribe('completions', (e) => void sub.push(e.type), { types: ['course.completed'] });
    bus.listen((e) => void tenantOnly.push(`${e.tenantId}:${e.type}`), { tenantId: 't1' });
    bus.listen((e) => void typed.push(e.type), { tenantId: 't1', types: ['score.updated'] });

    await bus.publish('t1', 'course.completed', {});
    await bus.publish('t1', 'score.updated', {});
    await bus.publish('t2', 'course.completed', {});

    expect(sub).toEqual(['course.completed', 'course.completed']);
    expect(tenantOnly).toEqual(['t1:course.completed', 't1:score.updated']);
    expect(typed).toEqual(['score.updated']);
  });

  it('isolates a failing subscriber: others still run, the failure is logged, the publisher never sees it', async () => {
    const log = logger();
    const bus = new EventBus({ logger: log });
    const ok = vi.fn();
    bus.subscribe('broken', () => {
      throw new Error('boom');
    });
    bus.subscribe('async-broken', async () => {
      throw new Error('later boom');
    });
    bus.subscribe('fine', ok);
    bus.listen(() => {
      throw new Error('listener boom');
    });

    await expect(bus.publish('t1', 'course.passed', {})).resolves.toMatchObject({ type: 'course.passed' });
    await bus.idle();

    expect(ok).toHaveBeenCalledOnce();
    const subscriberFailures = log.error.mock.calls.filter(([, msg]) => msg === 'event subscriber failed');
    expect(subscriberFailures.map(([obj]) => (obj as { subscriber: string }).subscriber).sort()).toEqual([
      'async-broken',
      'broken',
    ]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ type: 'course.passed' }), 'event listener failed');
  });

  it('replaces a subscriber registered twice under one name, and unsubscribes', async () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.subscribe('x', () => void calls.push('first'));
    const off = bus.subscribe('x', () => void calls.push('second'));
    const unlisten = bus.listen(() => void calls.push('listener'));
    await bus.publish('t1', 'course.completed', {});
    off();
    unlisten();
    await bus.publish('t1', 'course.completed', {});
    expect(calls).toEqual(['listener', 'second']);
  });

  it('idle waits for slow subscribers; close refuses further publishes', async () => {
    const log = logger();
    const bus = new EventBus({ logger: log });
    let finished = false;
    bus.subscribe('slow', async () => {
      await new Promise((r) => setTimeout(r, 20));
      finished = true;
    });
    bus.emit('t1', 'course.completed', {});
    expect(finished).toBe(false);
    await bus.close();
    expect(finished).toBe(true);

    await expect(bus.publish('t1', 'course.completed', {})).rejects.toThrow('closed');
    bus.emit('t1', 'course.completed', {});
    await bus.idle();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ type: 'course.completed' }), 'event publish failed');
  });

  it('accepts a custom transport', async () => {
    const transport = new MemoryTransport();
    const start = vi.spyOn(transport, 'start');
    const close = vi.spyOn(transport, 'close');
    const bus = new EventBus({ transport });
    await bus.start();
    await bus.start();
    await bus.close();
    expect(start).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
