import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import type { PrismaClient } from '../../src/db/client.js';
import { hashApiKey } from '../../src/auth/api-key.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';

const TENANT = 'tenant_test';
const API_KEY = 'sk_test_embed';
const COURSE_ID = 'course_1';
const ATTEMPT_ID = 'attempt_1';
const STORAGE_KEY = `tenants/${TENANT}/courses/${COURSE_ID}`;

/** Fake Prisma + seeded storage for the embed/content flow. */
function embedHarness() {
  const course = {
    id: COURSE_ID,
    tenantId: TENANT,
    scormVersion: 'SCORM_2004_4',
    masteryScore: 80,
    storageKey: STORAGE_KEY,
    launchUrl: `${STORAGE_KEY}/index.html`,
  };
  const learner = { id: 'l1', externalId: 'u1', name: 'Ada' };
  const attempts: any[] = [
    {
      id: ATTEMPT_ID,
      tenantId: TENANT,
      courseId: COURSE_ID,
      learnerId: 'l1',
      scoId: null,
      status: 'IN_PROGRESS',
      sessionTimeSeconds: 0,
      totalTimeSeconds: 0,
      cmiSnapshot: { 'cmi.location': 'page-2' },
    },
  ];
  const db = { objectives: [] as any[], interactions: [] as any[], commitLogs: [] as any[] };

  const pick = (row: any, select: any) => {
    const out: any = {};
    for (const k of Object.keys(select)) {
      const spec = select[k];
      out[k] = spec && typeof spec === 'object' && spec.select ? (row[k] ? pick(row[k], spec.select) : null) : row[k];
    }
    return out;
  };
  const resolve = (a: any) => ({ ...a, course, learner });

  const prisma = {
    apiKey: {
      findUnique: async ({ where }: any) =>
        where.hashedKey === hashApiKey(API_KEY) ? { id: 'k1', tenantId: TENANT, revokedAt: null } : null,
    },
    course: {
      findFirst: async ({ where, select }: any) => {
        if (where.id !== COURSE_ID || where.tenantId !== TENANT) return null;
        return select ? pick(course, select) : course;
      },
    },
    sco: { findFirst: async () => null },
    learner: { findUnique: async () => ({ id: learner.id }) },
    attempt: {
      findFirst: async ({ where, select }: any) => {
        const a = attempts.find(
          (x) =>
            (where.id ? x.id === where.id : true) &&
            (where.tenantId ? x.tenantId === where.tenantId : true) &&
            (where.courseId ? x.courseId === where.courseId : true) &&
            (where.status ? x.status === where.status : true),
        );
        if (!a) return null;
        return select ? pick(resolve(a), select) : a;
      },
      findMany: async () => [],
      update: async ({ where, data }: any) => {
        const a = attempts.find((x) => x.id === where.id);
        Object.assign(a, data);
        return a;
      },
    },
    objective: { deleteMany: async () => {}, createMany: async ({ data }: any) => db.objectives.push(...data) },
    interaction: { deleteMany: async () => {}, createMany: async ({ data }: any) => db.interactions.push(...data) },
    commitLog: { create: async ({ data }: any) => db.commitLogs.push(data) },
    $transaction: async (fn: any) => fn(prisma),
  } as unknown as PrismaClient;

  const storage = new MemoryStorage();
  storage.files.set(`${STORAGE_KEY}/index.html`, Buffer.from('<html>SCO</html>'));
  storage.files.set(`${STORAGE_KEY}/assets/app.js`, Buffer.from('console.log(1)'));

  return { prisma, storage, attempts, db };
}

describe('embed flow', () => {
  let app: FastifyInstance;
  let harness: ReturnType<typeof embedHarness>;
  const auth = { 'x-api-key': API_KEY };

  async function mintToken(attemptId = ATTEMPT_ID): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/attempt-token',
      headers: auth,
      payload: { attemptId },
    });
    return res.json().token;
  }

  beforeEach(async () => {
    harness = embedHarness();
    app = await buildApp({ env: createTestEnv(), prisma: harness.prisma, storage: harness.storage });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /auth/attempt-token', () => {
    it('requires an API key', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/attempt-token', payload: { attemptId: ATTEMPT_ID } });
      expect(res.statusCode).toBe(401);
    });

    it('mints a token for a known attempt', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/attempt-token', headers: auth, payload: { attemptId: ATTEMPT_ID } });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().token).toBe('string');
      expect(typeof res.json().expiresAt).toBe('string');
    });

    it('404s an unknown attempt', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/attempt-token', headers: auth, payload: { attemptId: 'nope' } });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /runtime.js', () => {
    it('serves the bridge script', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/runtime.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('javascript');
      expect(res.body).toContain('window.API_1484_11');
      expect(res.body).toContain('window.API');
    });
  });

  describe('GET /play/:attemptId', () => {
    it('rejects a missing token', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/play/${ATTEMPT_ID}` });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a token for a different attempt', async () => {
      const token = await mintToken(ATTEMPT_ID);
      const res = await app.inject({ method: 'GET', url: `/api/v1/play/other_attempt?token=${token}` });
      expect(res.statusCode).toBe(403);
    });

    it('renders the player page with engine-hosted content and sets the auth cookie', async () => {
      const token = await mintToken();
      const res = await app.inject({ method: 'GET', url: `/api/v1/play/${ATTEMPT_ID}?token=${token}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('__SCORMFLOW__');
      expect(res.body).toContain(`/courses/${COURSE_ID}/content/index.html`);
      // Hydrated CMI is embedded so the API is synchronously ready.
      expect(res.body).toContain('page-2');
      expect(String(res.headers['set-cookie'])).toContain('sf_attempt=');
    });

    it('renders external content without a cookie', async () => {
      const token = await mintToken();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/play/${ATTEMPT_ID}?token=${token}&source=external&src=${encodeURIComponent('https://cdn.example.com/sco/index.html')}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('https://cdn.example.com/sco/index.html');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('400s external source without a src url', async () => {
      const token = await mintToken();
      const res = await app.inject({ method: 'GET', url: `/api/v1/play/${ATTEMPT_ID}?token=${token}&source=external` });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /courses/:courseId/content/*', () => {
    it('serves a file with an attempt cookie', async () => {
      const token = await mintToken();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_ID}/content/index.html`,
        headers: { cookie: `sf_attempt=${encodeURIComponent(token)}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<html>SCO</html>');
    });

    it('serves a nested asset with the correct content type', async () => {
      const token = await mintToken();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_ID}/content/assets/app.js`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('javascript');
    });

    it('401s without any credential', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/courses/${COURSE_ID}/content/index.html` });
      expect(res.statusCode).toBe(401);
    });

    it('404s a missing file', async () => {
      const token = await mintToken();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_ID}/content/missing.html`,
        headers: { cookie: `sf_attempt=${encodeURIComponent(token)}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects path traversal', async () => {
      const token = await mintToken();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/courses/${COURSE_ID}/content/..%2f..%2fsecret`,
        headers: { cookie: `sf_attempt=${encodeURIComponent(token)}` },
      });
      expect([400, 404]).toContain(res.statusCode);
    });
  });

  describe('commit with an attempt token', () => {
    it('accepts a Bearer attempt token', async () => {
      const token = await mintToken();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/attempts/${ATTEMPT_ID}/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: { values: { 'cmi.completion_status': 'completed' } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().summary.completionStatus).toBe('completed');
    });

    it('rejects a token scoped to a different attempt', async () => {
      // Mint a valid token, then aim it at a different attempt id in the path.
      const token = await mintToken(ATTEMPT_ID);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/attempts/someone_else/commit`,
        headers: { authorization: `Bearer ${token}` },
        payload: { values: {} },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
