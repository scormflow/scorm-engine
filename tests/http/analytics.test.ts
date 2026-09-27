import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import type { PrismaClient } from '../../src/db/client.js';
import { hashApiKey } from '../../src/auth/api-key.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';

const TENANT = 'tenant_test';
const API_KEY = 'sk_test_analytics';

/** Fake Prisma covering auth + the analytics read surface with one course + learner. */
function analyticsPrisma() {
  const client = {
    apiKey: {
      findUnique: async ({ where }: any) =>
        where.hashedKey === hashApiKey(API_KEY)
          ? { id: 'k1', tenantId: TENANT, revokedAt: null }
          : null,
    },
    course: {
      count: async () => 1,
      findFirst: async ({ where }: any) =>
        where.id === 'course_1' && where.tenantId === TENANT ? { id: 'course_1' } : null,
    },
    learner: {
      count: async () => 1,
      findUnique: async ({ where }: any) =>
        where.tenantId_externalId.externalId === 'u1' ? { id: 'l1' } : null,
    },
    attempt: {
      count: async () => 2,
      aggregate: async ({ _avg, _sum }: any) => ({
        ...(_avg ? { _avg: { scoreScaled: 0.75, sessionTimeSeconds: 240 } } : {}),
        ...(_sum ? { _sum: { sessionTimeSeconds: 480 } } : {}),
      }),
      groupBy: async () => [{ courseId: 'course_1' }],
      findMany: async () => [],
    },
  } as unknown as PrismaClient;
  return client;
}

describe('analytics routes', () => {
  let app: FastifyInstance;
  const auth = { 'x-api-key': API_KEY };

  beforeEach(async () => {
    app = await buildApp({ env: createTestEnv(), prisma: analyticsPrisma(), storage: new MemoryStorage() });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('returns a tenant overview', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/overview', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.courseCount).toBe(1);
    expect(body.attemptCount).toBe(2);
    expect(body.averageScore).toBe(0.75);
  });

  it('returns course analytics for a known course', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/courses/course_1',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().courseId).toBe('course_1');
  });

  it('404s course analytics for an unknown course', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/courses/missing',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns learner analytics for a known learner', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/learners/u1',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().learnerId).toBe('u1');
    expect(res.json().totalTimeSeconds).toBe(480);
  });

  it('404s learner analytics for an unknown learner', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/learners/ghost',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});
