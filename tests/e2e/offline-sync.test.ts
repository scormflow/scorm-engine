/**
 * Offline sync: a player that lost its connection replays its queued commits
 * through `POST /attempts/:id/sync` (or `commit` with a `seq`). Replays are
 * idempotent by sequence number, and commits that arrive after the attempt was
 * finished are reported as conflicts instead of reopening it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import type { WebhookDispatcher } from '../../src/webhooks/index.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMemoryDb, type MemoryDb } from '../helpers/memory-db.js';
import { buildScormZip } from '../helpers/scorm-fixture.js';

const TENANT = 'tenant_sync';
const API_KEY = 'sk_test_offline_sync';
const apiKey = { 'x-api-key': API_KEY };

describe('offline commit sync', () => {
  let app: FastifyInstance;
  let db: MemoryDb;
  let events: string[];
  let attemptId: string;

  beforeEach(async () => {
    db = createMemoryDb({ tenantId: TENANT, apiKey: API_KEY });
    events = [];
    const webhooks = {
      enqueue: async ({ type }: { type: string }) => events.push(type),
      start: () => undefined,
      stop: async () => undefined,
    } as unknown as WebhookDispatcher;
    app = await buildApp({ env: createTestEnv(), prisma: db.prisma, storage: new MemoryStorage(), webhooks });
    await app.ready();

    const boundary = '----sync-boundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="course.zip"\r\n` +
          'Content-Type: application/zip\r\n\r\n',
      ),
      buildScormZip({ version: '2004', title: 'Offline Course' }),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      payload,
      headers: { ...apiKey, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(uploaded.statusCode).toBe(201);
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${uploaded.json().id}/attempts`,
      payload: { learnerId: 'field-worker-7' },
      headers: apiKey,
    });
    expect(started.statusCode).toBe(201);
    attemptId = started.json().attemptId;
  });

  afterEach(async () => {
    await app.close();
  });

  const sync = (commits: unknown) =>
    app.inject({ method: 'POST', url: `/api/v1/attempts/${attemptId}/sync`, payload: { commits }, headers: apiKey });
  const commit = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/attempts/${attemptId}/commit`, payload: body, headers: apiKey });
  const runtime = async () =>
    (await app.inject({ method: 'GET', url: `/api/v1/attempts/${attemptId}/runtime`, headers: apiKey })).json();

  it('replays a queue in seq order and records seq + recordedAt in the commit log', async () => {
    const res = await sync([
      { seq: 2, values: { 'cmi.location': 'page-5', 'cmi.progress_measure': '0.5' }, recordedAt: '2026-10-11T08:01:00Z' },
      { seq: 1, values: { 'cmi.location': 'page-2', 'cmi.completion_status': 'incomplete' }, recordedAt: '2026-10-11T08:00:00Z' },
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lastCommitSeq).toBe(2);
    expect(body.results.map((r: any) => [r.seq, r.status])).toEqual([
      [1, 'applied'],
      [2, 'applied'],
    ]);
    expect(body.summary.completionStatus).toBe('incomplete');

    const state = await runtime();
    // seq 2 was recorded last, so its location wins even though it arrived first.
    expect(state.cmi['cmi.location']).toBe('page-5');
    expect(state.lastCommitSeq).toBe(2);
    expect(db.tables.commitLogs.map((l) => l.seq)).toEqual([1, 2]);
    expect(db.tables.commitLogs[0]!.recordedAt).toEqual(new Date('2026-10-11T08:00:00Z'));
  });

  it('acknowledges a resent queue as duplicates without re-applying it', async () => {
    const queue = [
      { seq: 1, values: { 'cmi.location': 'page-2' } },
      { seq: 2, values: { 'cmi.location': 'page-3' } },
    ];
    await sync(queue);
    // Connection dropped before the client saw the response: it resends everything plus one more.
    const res = await sync([...queue, { seq: 3, values: { 'cmi.location': 'page-4' } }]);
    expect(res.json().results.map((r: any) => r.status)).toEqual(['duplicate', 'duplicate', 'applied']);
    expect(db.tables.commitLogs).toHaveLength(3);
    expect((await runtime()).cmi['cmi.location']).toBe('page-4');
  });

  it('dedupes repeated seqs inside a single batch', async () => {
    const res = await sync([
      { seq: 1, values: { 'cmi.location': 'a' } },
      { seq: 1, values: { 'cmi.location': 'b' } },
    ]);
    expect(res.json().results.map((r: any) => r.status)).toEqual(['applied', 'duplicate']);
    expect((await runtime()).cmi['cmi.location']).toBe('a');
  });

  it('reports commits after a terminate as conflicts', async () => {
    const res = await sync([
      { seq: 1, values: { 'cmi.completion_status': 'completed', 'cmi.exit': 'normal' }, terminate: true },
      { seq: 2, values: { 'cmi.location': 'too-late' } },
    ]);
    const body = res.json();
    expect(body.results.map((r: any) => [r.status, r.terminated])).toEqual([
      ['applied', true],
      ['conflict', false],
    ]);
    expect(body.lastCommitSeq).toBe(1);
    expect(events).toContain('attempt.terminated');

    // Replaying the terminate itself is still acknowledged so the client can clear it.
    const replay = await sync([{ seq: 1, values: {}, terminate: true }]);
    expect(replay.json().results[0].status).toBe('duplicate');
  });

  it('makes a live commit carrying a seq idempotent', async () => {
    const first = await commit({ seq: 5, values: { 'cmi.location': 'x' } });
    expect(first.json()).toMatchObject({ ok: true, duplicate: false });
    const again = await commit({ seq: 5, values: { 'cmi.location': 'y' } });
    expect(again.json()).toMatchObject({ ok: true, duplicate: true });
    expect((await runtime()).cmi['cmi.location']).toBe('x');

    // Commits without a seq keep the old always-apply behaviour.
    await commit({ values: { 'cmi.location': 'z' } });
    const state = await runtime();
    expect(state.cmi['cmi.location']).toBe('z');
    expect(state.lastCommitSeq).toBe(5);
  });

  it('validates the sync payload', async () => {
    expect((await sync([])).statusCode).toBe(400);
    expect((await sync([{ values: {} }])).json().message).toBe('commits[0]: seq is required');
    expect((await sync([{ seq: -1, values: {} }])).statusCode).toBe(400);
    expect((await sync([{ seq: 1, values: {}, recordedAt: 'yesterday' }])).statusCode).toBe(400);
    expect((await commit({ seq: 1.5, values: {} })).statusCode).toBe(400);
  });

  it('returns 404 for an unknown attempt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/attempts/nope/sync',
      payload: { commits: [{ seq: 1, values: {} }] },
      headers: apiKey,
    });
    expect(res.statusCode).toBe(404);
  });
});
