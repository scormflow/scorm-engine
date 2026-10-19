import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderBridgeConfig, renderRuntimeBridge, type BridgeReplayConfig } from '../../src/http/runtime-bridge.js';

/**
 * Runs the served bridge script against a minimal fake browser: EventTarget
 * stand-ins for window, document and a same-origin content iframe, and a
 * recording fetch.
 */

interface FetchCall {
  url: string;
  body: any;
  keepalive: boolean;
}

function fakeDocument(extra: Record<string, unknown> = {}) {
  return Object.assign(new EventTarget(), { visibilityState: 'visible', readyState: 'complete' }, extra);
}

function boot(opts: { version?: string; replay?: BridgeReplayConfig; status?: number } = {}) {
  const calls: FetchCall[] = [];
  let status = opts.status ?? 200;
  const fetch = vi.fn(async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), keepalive: init.keepalive === true });
    return { ok: status >= 200 && status < 300, status };
  });

  const content = fakeDocument({ defaultView: { innerWidth: 800, innerHeight: 400 } });
  const iframe = Object.assign(new EventTarget(), { contentDocument: content });
  const document = fakeDocument({
    getElementById: (id: string) => (id === 'sco' ? iframe : null),
    querySelector: () => iframe,
  });
  const window: any = Object.assign(new EventTarget(), {
    document,
    __SCORMFLOW__: {
      apiBase: 'https://engine.test/api/v1/',
      attemptId: 'att_1',
      token: 'tok',
      version: opts.version ?? 'SCORM_2004_4',
      cmi: { 'cmi.location': 'p1' },
      ...(opts.replay ? { replay: opts.replay } : {}),
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', renderRuntimeBridge())(
    window,
    fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  );

  const replayCalls = () => calls.filter((c) => c.url.endsWith('/replay/events'));
  const replayEvents = () => replayCalls().flatMap((c) => c.body.events);
  return {
    window,
    document,
    content,
    iframe,
    calls,
    replayCalls,
    replayEvents,
    setStatus: (s: number) => (status = s),
    api: window.API_1484_11 ?? window.API,
  };
}

/** Let resolved fetch promises and their `.then` chains run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function pointer(x: number, y: number): Event {
  return Object.assign(new Event('pointerdown'), { clientX: x, clientY: y });
}

describe('runtime bridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes the SCORM 2004 API seeded from the config', () => {
    const { api } = boot();
    expect(api.Initialize('')).toBe('true');
    expect(api.GetValue('cmi.location')).toBe('p1');
  });

  it('commits through the attempt endpoint with the token', async () => {
    const { api, calls } = boot();
    api.Initialize('');
    api.SetValue('cmi.location', 'p2');
    api.Commit('');
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://engine.test/api/v1/attempts/att_1/commit');
    expect(calls[0]!.body).toEqual({ values: { 'cmi.location': 'p2' }, terminate: false });
  });

  it('records nothing without a replay config', async () => {
    const { api, document, replayCalls } = boot();
    api.Initialize('');
    api.SetValue('cmi.location', 'p2');
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(replayCalls()).toHaveLength(0);
  });

  describe('with replay capture', () => {
    it('records navigation when the location changes and flushes on the interval', async () => {
      const { api, replayCalls, replayEvents } = boot({ replay: {} });
      api.Initialize('');
      api.SetValue('cmi.location', 'p1'); // unchanged — not a move
      api.SetValue('cmi.location', 'p2');
      expect(replayCalls()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(5000);
      const [call] = replayCalls();
      expect(call!.url).toBe('https://engine.test/api/v1/attempts/att_1/replay/events');
      expect(call!.keepalive).toBe(false);
      expect(replayEvents()).toEqual([
        { id: expect.stringMatching(/^[A-Za-z0-9._:-]{1,64}$/), type: 'navigation', location: 'p2', at: '2026-10-19T10:00:00.000Z' },
      ]);

      // Sent events are not sent again.
      await vi.advanceTimersByTimeAsync(5000);
      expect(replayCalls()).toHaveLength(1);
    });

    it('uses the SCORM 1.2 location element for 1.2 content', async () => {
      const { api, replayEvents } = boot({ version: 'SCORM_1_2', replay: {} });
      api.LMSInitialize('');
      api.LMSSetValue('cmi.core.lesson_location', 'slide-3');
      await vi.advanceTimersByTimeAsync(5000);
      expect(replayEvents().map((e: any) => [e.type, e.location])).toEqual([['navigation', 'slide-3']]);
    });

    it('records the tab being hidden and flushes with keepalive', async () => {
      const { document, replayCalls, replayEvents } = boot({ replay: {} });
      document.visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await settle();
      expect(replayCalls()[0]!.keepalive).toBe(true);
      document.visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(5000);
      expect(replayEvents().map((e: any) => e.type)).toEqual(['page.hidden', 'page.visible']);
    });

    it('records idle stretches, ended by activity inside the content', async () => {
      const { content, replayEvents } = boot({ replay: { idleMs: 30_000, flushMs: 60_000 } });
      await vi.advanceTimersByTimeAsync(30_000);
      content.dispatchEvent(new Event('keydown'));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(replayEvents().map((e: any) => e.type)).toEqual(['idle.start', 'idle.end']);
    });

    it('records pointer positions only when asked to', async () => {
      const off = boot({ replay: {} });
      off.content.dispatchEvent(pointer(400, 100));
      await vi.advanceTimersByTimeAsync(5000);
      expect(off.replayEvents()).toHaveLength(0);

      const on = boot({ replay: { pointer: true } });
      on.content.dispatchEvent(pointer(400, 100));
      await vi.advanceTimersByTimeAsync(5000);
      expect(on.replayEvents()).toEqual([expect.objectContaining({ type: 'pointer', data: { x: 0.5, y: 0.25 } })]);
    });

    it('records media playback inside the content', async () => {
      const { content, replayEvents } = boot({ replay: {} });
      const video = Object.assign(new EventTarget(), { currentSrc: 'https://cdn.test/intro.mp4', currentTime: 12.34 });
      // Media events don't bubble; the bridge listens on the document in the capture phase.
      content.dispatchEvent(Object.defineProperty(new Event('play'), 'target', { value: video }));
      await vi.advanceTimersByTimeAsync(5000);
      expect(replayEvents()).toEqual([
        expect.objectContaining({ type: 'media.play', data: { src: 'https://cdn.test/intro.mp4', time: 12.3 } }),
      ]);
    });

    it('stops capturing once the engine says capture is off', async () => {
      const { api, replayCalls } = boot({ replay: {}, status: 403 });
      api.Initialize('');
      api.SetValue('cmi.location', 'p2');
      await vi.advanceTimersByTimeAsync(5000);
      expect(replayCalls()).toHaveLength(1);
      api.SetValue('cmi.location', 'p3');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(replayCalls()).toHaveLength(1);
    });

    it('keeps events after a failed send and retries them', async () => {
      const { api, replayCalls, setStatus } = boot({ replay: {}, status: 503 });
      api.Initialize('');
      api.SetValue('cmi.location', 'p2');
      await vi.advanceTimersByTimeAsync(5000);
      setStatus(200);
      await vi.advanceTimersByTimeAsync(5000);
      expect(replayCalls()).toHaveLength(2);
      expect(replayCalls()[1]!.body.events[0].id).toBe(replayCalls()[0]!.body.events[0].id);
      await vi.advanceTimersByTimeAsync(5000);
      expect(replayCalls()).toHaveLength(2);
    });

    it('drains every buffered event on Terminate, in keepalive batches', async () => {
      const { api, replayCalls, replayEvents } = boot({ replay: { flushMs: 0 } });
      api.Initialize('');
      for (let i = 0; i < 80; i++) api.SetValue('cmi.location', `p${i + 2}`);
      api.Terminate('');
      await settle();
      expect(replayCalls().map((c) => [c.body.events.length, c.keepalive])).toEqual([
        [50, true],
        [30, true],
      ]);
      expect(new Set(replayEvents().map((e: any) => e.id)).size).toBe(80);
      // Nothing more is recorded after Terminate.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(replayCalls()).toHaveLength(2);
    });
  });
});

describe('renderBridgeConfig', () => {
  it('escapes "<" so the JSON cannot close the script tag', () => {
    const out = renderBridgeConfig({
      apiBase: 'https://engine.test/api/v1',
      attemptId: 'a',
      token: 't',
      version: 'SCORM_1_2',
      cmi: { 'cmi.suspend_data': '</script><script>alert(1)</script>' },
    });
    expect(out).not.toContain('</script>');
    expect(out.startsWith('window.__SCORMFLOW__ = {')).toBe(true);
  });
});
