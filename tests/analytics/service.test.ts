import { describe, expect, it } from 'vitest';

import type { PrismaClient } from '../../src/db/client.js';
import {
  getCourseAnalytics,
  getLearnerAnalytics,
  getOverview,
} from '../../src/analytics/service.js';

interface AttemptSeed {
  id: string;
  courseId: string;
  learnerId: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'TERMINATED' | 'EXPIRED';
  successStatus?: 'PASSED' | 'FAILED' | 'UNKNOWN';
  scoreScaled?: number | null;
  sessionTimeSeconds?: number;
  startedAt?: number;
}

/**
 * In-memory Prisma stand-in implementing the count/aggregate/groupBy/findMany
 * surface the analytics service uses. Attempts are matched against `where`
 * clauses containing tenantId/courseId/learnerId/status/successStatus.
 */
function analyticsPrisma(seed: {
  tenantId?: string;
  courses?: number;
  learners?: Array<{ id: string; externalId: string }>;
  attempts?: AttemptSeed[];
}) {
  const tenantId = seed.tenantId ?? 't1';
  const learners = seed.learners ?? [];
  const attempts: any[] = (seed.attempts ?? []).map((a) => ({
    tenantId,
    scoreScaled: null,
    sessionTimeSeconds: 0,
    successStatus: 'UNKNOWN',
    startedAt: 0,
    ...a,
  }));

  const match = (a: any, where: any): boolean => {
    if (where.tenantId && a.tenantId !== where.tenantId) return false;
    if (where.courseId && a.courseId !== where.courseId) return false;
    if (where.learnerId && a.learnerId !== where.learnerId) return false;
    if (where.status && a.status !== where.status) return false;
    if (where.successStatus && a.successStatus !== where.successStatus) return false;
    if (where.scoreScaled?.not === null && a.scoreScaled == null) return false;
    return true;
  };

  const client = {
    course: { count: async ({ where }: any) => (where.tenantId === tenantId ? (seed.courses ?? 0) : 0) },
    learner: {
      count: async ({ where }: any) => (where.tenantId === tenantId ? learners.length : 0),
      findUnique: async ({ where }: any) => {
        const k = where.tenantId_externalId;
        const l = learners.find((x) => x.externalId === k.externalId);
        return l ? { id: l.id } : null;
      },
    },
    attempt: {
      count: async ({ where }: any) => attempts.filter((a) => match(a, where)).length,
      aggregate: async ({ where, _avg, _sum }: any) => {
        const rows = attempts.filter((a) => match(a, where));
        const out: any = {};
        if (_avg) {
          out._avg = {};
          for (const key of Object.keys(_avg)) {
            const vals = rows.map((r) => r[key]).filter((v) => v != null);
            out._avg[key] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
          }
        }
        if (_sum) {
          out._sum = {};
          for (const key of Object.keys(_sum)) {
            out._sum[key] = rows.reduce((s, r) => s + (r[key] ?? 0), 0);
          }
        }
        return out;
      },
      groupBy: async ({ by, where }: any) => {
        const rows = attempts.filter((a) => match(a, where));
        const keys = new Set(rows.map((r) => r[by[0]]));
        return [...keys].map((v) => ({ [by[0]]: v }));
      },
      findMany: async ({ where, take }: any) => {
        const rows = attempts
          .filter((a) => match(a, where))
          .sort((x, y) => y.startedAt - x.startedAt)
          .slice(0, take);
        return rows.map((r) => ({ ...r, objectives: [], interactions: [] }));
      },
    },
  } as unknown as PrismaClient;

  return { prisma: client, tenantId };
}

describe('getOverview', () => {
  it('computes counts, completion rate and average score', async () => {
    const { prisma } = analyticsPrisma({
      courses: 3,
      learners: [{ id: 'l1', externalId: 'u1' }, { id: 'l2', externalId: 'u2' }],
      attempts: [
        { id: 'a1', courseId: 'c1', learnerId: 'l1', status: 'COMPLETED', scoreScaled: 0.8 },
        { id: 'a2', courseId: 'c1', learnerId: 'l2', status: 'COMPLETED', scoreScaled: 0.6 },
        { id: 'a3', courseId: 'c2', learnerId: 'l1', status: 'IN_PROGRESS', scoreScaled: null },
        { id: 'a4', courseId: 'c2', learnerId: 'l2', status: 'TERMINATED', scoreScaled: null },
      ],
    });
    const overview = await getOverview('t1', prisma);
    expect(overview.courseCount).toBe(3);
    expect(overview.learnerCount).toBe(2);
    expect(overview.attemptCount).toBe(4);
    expect(overview.completionRate).toBe(0.5); // 2 of 4
    expect(overview.averageScore).toBe(0.7); // avg of 0.8, 0.6
  });

  it('returns zero completion rate and null score with no data', async () => {
    const { prisma } = analyticsPrisma({ courses: 0 });
    const overview = await getOverview('t1', prisma);
    expect(overview.completionRate).toBe(0);
    expect(overview.averageScore).toBeNull();
  });
});

describe('getCourseAnalytics', () => {
  it('computes completion, pass rate, average time and recent attempts', async () => {
    const { prisma } = analyticsPrisma({
      attempts: [
        { id: 'a1', courseId: 'c1', learnerId: 'l1', status: 'COMPLETED', successStatus: 'PASSED', scoreScaled: 0.9, sessionTimeSeconds: 300, startedAt: 3 },
        { id: 'a2', courseId: 'c1', learnerId: 'l2', status: 'COMPLETED', successStatus: 'FAILED', scoreScaled: 0.4, sessionTimeSeconds: 500, startedAt: 2 },
        { id: 'a3', courseId: 'c1', learnerId: 'l3', status: 'IN_PROGRESS', successStatus: 'UNKNOWN', scoreScaled: null, sessionTimeSeconds: 100, startedAt: 1 },
      ],
    });
    const a = await getCourseAnalytics('t1', 'c1', prisma);
    expect(a.attemptCount).toBe(3);
    expect(a.completionCount).toBe(2);
    expect(a.completionRate).toBeCloseTo(0.6667, 3);
    expect(a.averageScore).toBeCloseTo(0.65, 5); // (0.9 + 0.4) / 2
    expect(a.averageTimeSeconds).toBe(300); // (300 + 500 + 100) / 3
    expect(a.passRate).toBe(0.5); // 1 passed of 2 decided
    expect(a.recentAttempts).toHaveLength(3);
    // Most recent first.
    expect((a.recentAttempts[0] as any).id).toBe('a1');
  });

  it('returns null pass rate when no attempt has a decided success status', async () => {
    const { prisma } = analyticsPrisma({
      attempts: [
        { id: 'a1', courseId: 'c1', learnerId: 'l1', status: 'IN_PROGRESS', successStatus: 'UNKNOWN' },
      ],
    });
    const a = await getCourseAnalytics('t1', 'c1', prisma);
    expect(a.passRate).toBeNull();
  });
});

describe('getLearnerAnalytics', () => {
  it('rolls up a known learner', async () => {
    const { prisma } = analyticsPrisma({
      learners: [{ id: 'l1', externalId: 'u1' }],
      attempts: [
        { id: 'a1', courseId: 'c1', learnerId: 'l1', status: 'COMPLETED', sessionTimeSeconds: 200, startedAt: 2 },
        { id: 'a2', courseId: 'c2', learnerId: 'l1', status: 'COMPLETED', sessionTimeSeconds: 300, startedAt: 3 },
        { id: 'a3', courseId: 'c1', learnerId: 'l1', status: 'IN_PROGRESS', sessionTimeSeconds: 50, startedAt: 1 },
      ],
    });
    const a = await getLearnerAnalytics('t1', 'u1', prisma);
    expect(a).not.toBeNull();
    expect(a!.attemptCount).toBe(3);
    expect(a!.completedCourseCount).toBe(2); // c1 + c2 completed (distinct)
    expect(a!.totalTimeSeconds).toBe(550);
    expect((a!.recentAttempts[0] as any).id).toBe('a2'); // highest startedAt
  });

  it('returns null for an unknown learner', async () => {
    const { prisma } = analyticsPrisma({ learners: [] });
    expect(await getLearnerAnalytics('t1', 'ghost', prisma)).toBeNull();
  });
});
