import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import type { PrismaClient } from '../../src/db/client.js';
import { hashApiKey } from '../../src/auth/api-key.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';

const TENANT = 'tenant_test';
const API_KEY = 'sk_test_attempts';
const COURSE_ID = 'course_1';

/**
 * Fake Prisma tailored to the attempts routes: API-key auth, one seeded course,
 * plus learner/attempt/child-row operations. Lives here (not in the shared
 * mock) so the runtime routes can be exercised through the real Fastify app.
 */
function attemptsPrisma() {
  const db = {
    learners: [] as any[],
    attempts: [] as any[],
    objectives: [] as any[],
    interactions: [] as any[],
    commitLogs: [] as any[],
    seq: 0,
  };
  const id = (p: string) => `${p}_${++db.seq}`;
  const course = { id: COURSE_ID, tenantId: TENANT, scormVersion: 'SCORM_2004_4', masteryScore: 80 };

  const pick = (row: any, select: any) => {
    const out: any = {};
    for (const key of Object.keys(select)) {
      const spec = select[key];
      if (spec && typeof spec === 'object' && spec.select) {
        out[key] = row[key] ? pick(row[key], spec.select) : null;
      } else {
        out[key] = row[key];
      }
    }
    return out;
  };

  const resolveAttempt = (a: any) => ({
    ...a,
    course,
    learner: db.learners.find((l) => l.id === a.learnerId) ?? null,
  });

  const client = {
    apiKey: {
      findUnique: async ({ where }: any) =>
        where.hashedKey === hashApiKey(API_KEY)
          ? { id: 'apikey_1', tenantId: TENANT, revokedAt: null }
          : null,
    },
    course: {
      findFirst: async ({ where, select }: any) => {
        if (where.id !== course.id || where.tenantId !== TENANT) return null;
        return select ? pick(course, select) : course;
      },
    },
    learner: {
      upsert: async ({ where, create }: any) => {
        const k = where.tenantId_externalId;
        let row = db.learners.find((l) => l.tenantId === k.tenantId && l.externalId === k.externalId);
        if (!row) {
          row = { id: id('learner'), ...create };
          db.learners.push(row);
        }
        return { id: row.id };
      },
    },
    attempt: {
      findFirst: async ({ where, select, include }: any) => {
        const row = db.attempts.find(
          (a) =>
            (where.id ? a.id === where.id : true) &&
            (where.tenantId ? a.tenantId === where.tenantId : true) &&
            (where.status ? a.status === where.status : true) &&
            (where.learnerId ? a.learnerId === where.learnerId : true) &&
            (where.scoId !== undefined ? a.scoId === where.scoId : true),
        );
        if (!row) return null;
        const resolved = resolveAttempt(row);
        if (select) return pick(resolved, select);
        if (include) {
          return {
            ...row,
            objectives: db.objectives.filter((o) => o.attemptId === row.id),
            interactions: db.interactions.filter((i) => i.attemptId === row.id),
          };
        }
        return row;
      },
      findMany: async ({ where }: any) =>
        db.attempts.filter(
          (a) =>
            a.tenantId === where.tenantId &&
            a.courseId === where.courseId &&
            a.learnerId === where.learnerId &&
            (where.status?.in ? where.status.in.includes(a.status) : true) &&
            (where.id?.not ? a.id !== where.id.not : true),
        ),
      create: async ({ data }: any) => {
        const row = { id: id('attempt'), sessionTimeSeconds: 0, totalTimeSeconds: 0, scoId: null, cmiSnapshot: {}, ...data };
        db.attempts.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: any) => {
        const row = db.attempts.find((a) => a.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    objective: {
      deleteMany: async ({ where }: any) => {
        db.objectives = db.objectives.filter((o) => o.attemptId !== where.attemptId);
      },
      createMany: async ({ data }: any) => db.objectives.push(...data),
    },
    interaction: {
      deleteMany: async ({ where }: any) => {
        db.interactions = db.interactions.filter((i) => i.attemptId !== where.attemptId);
      },
      createMany: async ({ data }: any) => db.interactions.push(...data),
    },
    commitLog: { create: async ({ data }: any) => db.commitLogs.push(data) },
    $transaction: async (fn: any) => fn(client),
  } as unknown as PrismaClient;

  return { prisma: client, db };
}

describe('attempts runtime routes', () => {
  let app: FastifyInstance;
  const auth = { 'x-api-key': API_KEY };

  async function start(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/courses/${COURSE_ID}/attempts`,
      payload: body,
      headers: auth,
    });
  }

  let harness: ReturnType<typeof attemptsPrisma>;

  beforeEach(async () => {
    harness = attemptsPrisma();
    app = await buildApp({ env: createTestEnv(), prisma: harness.prisma, storage: new MemoryStorage() });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects an unauthenticated start', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${COURSE_ID}/attempts`,
      payload: { learnerId: 'u1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('requires a learnerId', async () => {
    const res = await start({});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('starts a fresh attempt (201, ab-initio)', async () => {
    const res = await start({ learnerId: 'u1', learnerName: 'Ada' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.resumed).toBe(false);
    expect(body.entry).toBe('ab-initio');
    expect(body.version).toBe('SCORM_2004_4');
    expect(body.cmi).toEqual({});
  });

  it('resumes the open attempt on a second start (200, resume)', async () => {
    await start({ learnerId: 'u1' });
    const res = await start({ learnerId: 'u1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().resumed).toBe(true);
    expect(res.json().entry).toBe('resume');
  });

  it('404s starting an attempt on an unknown course', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/nope/attempts`,
      payload: { learnerId: 'u1' },
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('replays a commit through the runtime and persists the rollup', async () => {
    const attemptId = (await start({ learnerId: 'u1' })).json().attemptId;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/commit`,
      headers: auth,
      payload: {
        values: {
          'cmi.completion_status': 'completed',
          'cmi.success_status': 'passed',
          'cmi.score.scaled': '0.95',
          'cmi.session_time': 'PT5M',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.summary.completionStatus).toBe('completed');
    expect(body.summary.successStatus).toBe('passed');

    const row = harness.db.attempts[0];
    expect(row.completionStatus).toBe('COMPLETED');
    expect(row.scoreScaled).toBe(0.95);
    expect(row.sessionTimeSeconds).toBe(300);
  });

  it('lenient (default): accepts invalid writes as warnings and persists them', async () => {
    const attemptId = (await start({ learnerId: 'u1' })).json().attemptId;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/commit`,
      headers: auth,
      payload: {
        values: {
          'cmi.completion_status': 'banana', // invalid vocab
          'cmi.score.scaled': '0.5', // valid
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Lenient mode never surfaces errors and the commit succeeds as a whole.
    expect(body.ok).toBe(true);
    expect(body.errors).toHaveLength(0);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].element).toBe('cmi.completion_status');
    // Valid write persisted; invalid one persisted verbatim in the snapshot.
    expect(harness.db.attempts[0].scoreScaled).toBe(0.5);
    expect(harness.db.attempts[0].cmiSnapshot['cmi.completion_status']).toBe('banana');
  });

  it('terminates an attempt and blocks further commits', async () => {
    const attemptId = (await start({ learnerId: 'u1' })).json().attemptId;
    const term = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/commit`,
      headers: auth,
      payload: { values: { 'cmi.completion_status': 'completed' }, terminate: true },
    });
    expect(term.json().terminated).toBe(true);
    expect(harness.db.attempts[0].status).toBe('COMPLETED');

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/commit`,
      headers: auth,
      payload: { values: {} },
    });
    expect(again.statusCode).toBe(409);
  });

  it('reads an attempt back with its child rows', async () => {
    const attemptId = (await start({ learnerId: 'u1' })).json().attemptId;
    await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/commit`,
      headers: auth,
      payload: {
        values: {
          'cmi.objectives.0.id': 'obj-1',
          'cmi.objectives.0.completion_status': 'completed',
          'cmi.interactions.0.id': 'q1',
          'cmi.interactions.0.type': 'choice',
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/attempts/${attemptId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.objectives).toHaveLength(1);
    expect(body.objectives[0].identifier).toBe('obj-1');
    expect(body.interactions[0].identifier).toBe('q1');
  });

  it('404s reading an unknown attempt', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/attempts/nope`, headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it('serves runtime state as ab-initio for a fresh attempt', async () => {
    const attemptId = (await start({ learnerId: 'u1', learnerName: 'Ada' })).json().attemptId;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${attemptId}/runtime`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe('SCORM_2004_4');
    expect(body.entry).toBe('ab-initio');
    expect(body.cmi).toEqual({});
    expect(body.learner).toEqual({ id: 'u1', name: 'Ada' });
  });

  it('serves runtime state as resume once CMI has been committed', async () => {
    const attemptId = (await start({ learnerId: 'u1' })).json().attemptId;
    await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/commit`,
      headers: auth,
      payload: { values: { 'cmi.location': 'page-2' } },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${attemptId}/runtime`,
      headers: auth,
    });
    expect(res.json().entry).toBe('resume');
    expect(res.json().cmi['cmi.location']).toBe('page-2');
  });
});

describe('attempts runtime routes (strict validation mode)', () => {
  let app: FastifyInstance;
  let harness: ReturnType<typeof attemptsPrisma>;
  const auth = { 'x-api-key': API_KEY };

  beforeEach(async () => {
    harness = attemptsPrisma();
    app = await buildApp({
      env: createTestEnv({ SCORM_VALIDATION_MODE: 'strict' }),
      prisma: harness.prisma,
      storage: new MemoryStorage(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects invalid writes as errors and does not persist them', async () => {
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${COURSE_ID}/attempts`,
      payload: { learnerId: 'u1' },
      headers: auth,
    });
    const attemptId = started.json().attemptId;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/commit`,
      headers: auth,
      payload: {
        values: {
          'cmi.completion_status': 'banana', // invalid vocab
          'cmi.score.scaled': '0.5', // valid
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].element).toBe('cmi.completion_status');
    expect(body.warnings).toHaveLength(0);
    // Valid write persisted; invalid one dropped (model keeps its default,
    // never the rejected "banana").
    expect(harness.db.attempts[0].scoreScaled).toBe(0.5);
    expect(harness.db.attempts[0].cmiSnapshot['cmi.completion_status']).not.toBe('banana');
  });
});
