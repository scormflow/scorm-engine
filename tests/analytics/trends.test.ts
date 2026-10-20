import { describe, expect, it } from 'vitest';

import type { PrismaClient } from '../../src/db/client.js';
import { getScoreDistribution, getTrends } from '../../src/analytics/trends.js';

interface Row {
  courseId?: string;
  status?: string;
  successStatus?: string;
  scoreScaled?: number | null;
  startedAt: string;
  finishedAt?: string | null;
  lastCommitAt?: string | null;
}

/** Fake Prisma whose `attempt.findMany` honours the where clauses trends.ts sends. */
function trendsPrisma(rows: Row[]) {
  const attempts = rows.map((r) => ({
    tenantId: 't1',
    courseId: 'c1',
    status: 'IN_PROGRESS',
    successStatus: 'UNKNOWN',
    scoreScaled: null,
    finishedAt: null,
    lastCommitAt: null,
    ...r,
    startedAt: new Date(r.startedAt),
    ...(r.finishedAt ? { finishedAt: new Date(r.finishedAt) } : {}),
    ...(r.lastCommitAt ? { lastCommitAt: new Date(r.lastCommitAt) } : {}),
  }));
  const calls: any[] = [];
  const prisma = {
    attempt: {
      findMany: async ({ where }: any) => {
        calls.push(where);
        return attempts.filter((a: any) => {
          if (a.tenantId !== where.tenantId) return false;
          if (where.courseId && a.courseId !== where.courseId) return false;
          if (where.scoreScaled?.not === null && a.scoreScaled == null) return false;
          if (where.OR) {
            return where.OR.some((clause: any) => {
              const [field, cond] = Object.entries(clause)[0] as [string, any];
              return a[field] != null && a[field] >= cond.gte;
            });
          }
          return true;
        });
      },
    },
  } as unknown as PrismaClient;
  return { prisma, calls };
}

const NOW = new Date('2026-10-20T15:00:00Z');

describe('getTrends', () => {
  it('fills every day in the window and buckets starts and completions', async () => {
    const { prisma } = trendsPrisma([
      { startedAt: '2026-10-18T09:00:00Z' },
      {
        startedAt: '2026-10-18T10:00:00Z',
        status: 'COMPLETED',
        successStatus: 'PASSED',
        scoreScaled: 0.9,
        finishedAt: '2026-10-19T08:00:00Z',
      },
      {
        startedAt: '2026-10-19T10:00:00Z',
        status: 'COMPLETED',
        successStatus: 'FAILED',
        scoreScaled: 0.4,
        lastCommitAt: '2026-10-19T23:59:00Z',
      },
      // Started before the window, completed inside it.
      { startedAt: '2026-09-01T00:00:00Z', status: 'COMPLETED', finishedAt: '2026-10-20T01:00:00Z' },
    ]);

    const t = await getTrends('t1', prisma, { days: 3, now: NOW });
    expect(t.from).toBe('2026-10-18');
    expect(t.to).toBe('2026-10-20');
    expect(t.interval).toBe('day');
    expect(t.courseId).toBeNull();
    expect(t.buckets.map((b) => b.date)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20']);

    const [d18, d19, d20] = t.buckets;
    expect(d18).toMatchObject({ started: 2, completed: 0, averageScore: null });
    expect(d19).toMatchObject({ started: 1, completed: 2, passed: 1, failed: 1, averageScore: 0.65 });
    expect(d20).toMatchObject({ started: 0, completed: 1, passed: 0, failed: 0, averageScore: null });
    expect(t.totals).toEqual({ started: 3, completed: 3, passed: 1, failed: 1 });
  });

  it('scopes to a course and defaults to 30 days', async () => {
    const { prisma, calls } = trendsPrisma([
      { courseId: 'c1', startedAt: '2026-10-20T01:00:00Z' },
      { courseId: 'c2', startedAt: '2026-10-20T02:00:00Z' },
    ]);
    const t = await getTrends('t1', prisma, { courseId: 'c1', now: NOW });
    expect(t.buckets).toHaveLength(30);
    expect(t.from).toBe('2026-09-21');
    expect(t.courseId).toBe('c1');
    expect(t.totals.started).toBe(1);
    expect(calls[0].courseId).toBe('c1');
  });
});

describe('getScoreDistribution', () => {
  it('bins scores, clamping out-of-range values and computing mean/median from raw scores', async () => {
    const { prisma } = trendsPrisma([
      { startedAt: '2026-10-01T00:00:00Z', scoreScaled: 0.05 },
      { startedAt: '2026-10-01T00:00:00Z', scoreScaled: 0.55 },
      { startedAt: '2026-10-01T00:00:00Z', scoreScaled: 0.6 },
      { startedAt: '2026-10-01T00:00:00Z', scoreScaled: 1 },
      { startedAt: '2026-10-01T00:00:00Z', scoreScaled: -0.2 },
      { startedAt: '2026-10-01T00:00:00Z', scoreScaled: null },
    ]);
    const d = await getScoreDistribution('t1', 'c1', prisma, 4);
    expect(d.scoredCount).toBe(5);
    expect(d.bins).toEqual([
      { min: 0, max: 0.25, count: 2 }, // 0.05 and clamped -0.2
      { min: 0.25, max: 0.5, count: 0 },
      { min: 0.5, max: 0.75, count: 2 },
      { min: 0.75, max: 1, count: 1 }, // 1 lands in the last bin
    ]);
    expect(d.averageScore).toBe(0.4); // (0.05 + 0.55 + 0.6 + 1 - 0.2) / 5
    expect(d.medianScore).toBe(0.55);
  });

  it('returns empty bins and null stats without scored attempts', async () => {
    const { prisma } = trendsPrisma([]);
    const d = await getScoreDistribution('t1', 'c1', prisma);
    expect(d.bins).toHaveLength(10);
    expect(d.bins.every((b) => b.count === 0)).toBe(true);
    expect(d.averageScore).toBeNull();
    expect(d.medianScore).toBeNull();
  });
});
