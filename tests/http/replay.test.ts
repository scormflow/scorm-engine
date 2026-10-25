import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import type { WebhookDispatcher } from '../../src/webhooks/index.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMemoryDb, type MemoryDb } from '../helpers/memory-db.js';

const TENANT = 'tenant_replay';
const API_KEY = 'sk_test_replay';
const apiKey = { 'x-api-key': API_KEY };

describe('session replay', () => {
  let app: FastifyInstance;
  let db: MemoryDb;

  async function start(env = createTestEnv()) {
    db = createMemoryDb({ tenantId: TENANT, apiKey: API_KEY });
    const webhooks = {
      enqueue: async () => undefined,
      start: () => undefined,
      stop: async () => undefined,
    } as unknown as WebhookDispatcher;
    app = await buildApp({ env, prisma: db.prisma, storage: new MemoryStorage(), webhooks, plugins: [] });
    await app.ready();
    db.tables.courses.push({
      id: 'course_1',
      tenantId: TENANT,
      title: 'Phishing Basics',
      scormVersion: 'SCORM_2004_4',
      masteryScore: null,
    });
  }

  beforeEach(async () => start());
  afterEach(async () => app.close());

  async function newAttempt(learnerId = 'learner-1') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/courses/course_1/attempts',
      payload: { learnerId, learnerName: 'Ada Lovelace', restart: true },
      headers: apiKey,
    });
    expect([200, 201]).toContain(res.statusCode);
    return res.json().attemptId as string;
  }

  const commit = (attemptId: string, values: Record<string, string>, terminate = false) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/commit`,
      payload: { values, terminate },
      headers: apiKey,
    });

  async function tokenFor(attemptId: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/attempt-token',
      payload: { attemptId },
      headers: apiKey,
    });
    return { authorization: `Bearer ${res.json().token as string}` };
  }

  const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

  it('rebuilds the timeline from commits and capture events', async () => {
    const attemptId = await newAttempt();
    // Started a minute ago, so the capture events below fall inside it.
    db.tables.attempts.find((a) => a.id === attemptId)!.startedAt = new Date(Date.now() - 60_000);
    await commit(attemptId, { 'cmi.location': 'slide-1', 'cmi.completion_status': 'incomplete' });
    await commit(attemptId, {
      'cmi.location': 'slide-2',
      'cmi.interactions.0.id': 'q1',
      'cmi.interactions.0.result': 'correct',
    });

    const headers = await tokenFor(attemptId);
    const posted = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/replay/events`,
      headers,
      payload: {
        events: [
          { id: 'ev-1', type: 'page.hidden', at: soon(-3000) },
          { id: 'ev-2', type: 'page.visible', at: soon(-2000) },
          { id: 'ev-3', type: 'pointer', at: soon(-1500), data: { x: 0.2, y: 0.8 } },
        ],
      },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json()).toEqual({ accepted: 3, duplicates: 0, dropped: 0 });

    // A retried batch is stored once.
    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/replay/events`,
      headers,
      payload: {
        events: [
          { id: 'ev-1', type: 'page.hidden', at: soon(-3000) },
          { id: 'ev-4', type: 'media.play', at: soon(-1000) },
        ],
      },
    });
    expect(retried.json()).toEqual({ accepted: 1, duplicates: 1, dropped: 0 });
    expect(db.tables.replayEvents).toHaveLength(4);
    expect(db.tables.replayEvents[0]).toMatchObject({ tenantId: TENANT, attemptId });

    await commit(attemptId, { 'cmi.completion_status': 'completed', 'cmi.success_status': 'passed' }, true);

    const res = await app.inject({ method: 'GET', url: `/api/v1/attempts/${attemptId}/replay`, headers: apiKey });
    expect(res.statusCode).toBe(200);
    const replay = res.json();
    expect(replay).toMatchObject({
      attemptId,
      courseId: 'course_1',
      learner: { id: 'learner-1', name: 'Ada Lovelace' },
      captured: true,
      commits: 3,
      truncated: false,
    });
    const types = replay.entries.map((e: { type: string }) => e.type);
    expect(types[0]).toBe('attempt.started');
    expect(types).toContain('interaction.recorded');
    expect(types).toContain('page.hidden');
    expect(types[types.length - 1]).toBe('attempt.finished');
    expect(replay.visits.map((v: { location: string }) => v.location)).toEqual(['slide-1', 'slide-2']);
    expect(replay.engagement).toMatchObject({ focusLosses: 1, interactions: 1, locationsVisited: 2 });
    expect(replay.engagement.components.progress).toBe(1);
  });

  it('guards who can write and read replay data', async () => {
    const attemptId = await newAttempt();
    const other = await newAttempt('learner-2');
    const headers = await tokenFor(attemptId);
    const events = [{ type: 'page.hidden', at: soon(0) }];

    const anon = await app.inject({ method: 'POST', url: `/api/v1/attempts/${attemptId}/replay/events`, payload: { events } });
    expect(anon.statusCode).toBe(401);
    const theirs = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${other}/replay/events`,
      headers,
      payload: { events },
    });
    expect(theirs.statusCode).toBe(403);
    // Reading a replay is an admin view: the attempt token is not enough.
    const read = await app.inject({ method: 'GET', url: `/api/v1/attempts/${attemptId}/replay`, headers });
    expect(read.statusCode).toBe(401);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/attempts/nope/replay', headers: apiKey });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('attempt_not_found');

    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/replay/events`,
      headers: apiKey,
      payload: { events: [{ type: 'Bad Type', at: soon(0) }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('events[0]') });
  });

  it('caps stored events per attempt and can turn capture off', async () => {
    await app.close();
    await start(createTestEnv({ REPLAY_MAX_EVENTS_PER_ATTEMPT: 2 }));
    const attemptId = await newAttempt();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/replay/events`,
      headers: apiKey,
      payload: { events: [1, 2, 3].map((n) => ({ type: 'navigation', location: `p${n}`, at: soon(n) })) },
    });
    expect(res.json()).toEqual({ accepted: 2, duplicates: 0, dropped: 1 });

    await app.close();
    await start(createTestEnv({ REPLAY_CAPTURE_ENABLED: false }));
    const next = await newAttempt();
    const off = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${next}/replay/events`,
      headers: apiKey,
      payload: { events: [{ type: 'page.hidden', at: soon(0) }] },
    });
    expect(off.statusCode).toBe(403);
    expect(off.json().code).toBe('replay_capture_disabled');
    // Timelines from commits still work.
    const replay = await app.inject({ method: 'GET', url: `/api/v1/attempts/${next}/replay`, headers: apiKey });
    expect(replay.statusCode).toBe(200);
  });

  it('builds a course heatmap across attempts', async () => {
    const finished = await newAttempt('learner-a');
    await commit(finished, { 'cmi.location': 'intro' });
    await commit(finished, { 'cmi.location': 'quiz', 'cmi.interactions.0.id': 'q1', 'cmi.interactions.0.result': 'wrong' });
    await commit(finished, { 'cmi.location': 'quiz', 'cmi.completion_status': 'completed' }, true);

    const dropped = await newAttempt('learner-b');
    await commit(dropped, { 'cmi.location': 'intro' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/courses/course_1/heatmap', headers: apiKey });
    expect(res.statusCode).toBe(200);
    const heatmap = res.json();
    expect(heatmap).toMatchObject({ courseId: 'course_1', attempts: 2, completed: 1, grid: 10, truncated: false });
    expect(heatmap.locations.map((l: { location: string }) => l.location)).toEqual(['intro', 'quiz']);
    expect(heatmap.locations[0]).toMatchObject({ attempts: 2, dropOffs: 1 });
    expect(heatmap.locations[1]).toMatchObject({ attempts: 1, interactions: 1, dropOffs: 0 });

    const limited = await app.inject({ method: 'GET', url: '/api/v1/courses/course_1/heatmap?limit=1', headers: apiKey });
    expect(limited.json()).toMatchObject({ attempts: 1, truncated: true });

    const badLimit = await app.inject({ method: 'GET', url: '/api/v1/courses/course_1/heatmap?limit=0', headers: apiKey });
    expect(badLimit.statusCode).toBe(400);
    const badSince = await app.inject({ method: 'GET', url: '/api/v1/courses/course_1/heatmap?since=never', headers: apiKey });
    expect(badSince.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'GET', url: '/api/v1/courses/nope/heatmap', headers: apiKey });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('course_not_found');
  });
});
