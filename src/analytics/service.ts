/**
 * Analytics read models.
 *
 * Aggregates the Attempt table into the tenant/course/learner rollups exposed
 * under `/analytics/*`. Uses Prisma aggregate/count/groupBy so the heavy lifting
 * stays in the database rather than pulling every row into memory.
 */
import type { PrismaClient } from '../db/client.js';
import { serializeAttempt } from '../http/serialize-attempt.js';

const RECENT_LIMIT = 10;

export interface AnalyticsOverview {
  courseCount: number;
  learnerCount: number;
  attemptCount: number;
  completionRate: number;
  averageScore: number | null;
}

export interface CourseAnalytics {
  courseId: string;
  attemptCount: number;
  completionCount: number;
  completionRate: number;
  averageScore: number | null;
  averageTimeSeconds: number | null;
  passRate: number | null;
  recentAttempts: Record<string, unknown>[];
}

export interface LearnerAnalytics {
  learnerId: string;
  attemptCount: number;
  completedCourseCount: number;
  totalTimeSeconds: number;
  recentAttempts: Record<string, unknown>[];
}

/** Tenant-wide rollup. */
export async function getOverview(
  tenantId: string,
  prisma: PrismaClient,
): Promise<AnalyticsOverview> {
  const [courseCount, learnerCount, attemptCount, completionCount, scoreAgg] = await Promise.all([
    prisma.course.count({ where: { tenantId } }),
    prisma.learner.count({ where: { tenantId } }),
    prisma.attempt.count({ where: { tenantId } }),
    prisma.attempt.count({ where: { tenantId, status: 'COMPLETED' } }),
    prisma.attempt.aggregate({
      where: { tenantId, scoreScaled: { not: null } },
      _avg: { scoreScaled: true },
    }),
  ]);

  return {
    courseCount,
    learnerCount,
    attemptCount,
    completionRate: ratio(completionCount, attemptCount),
    averageScore: round(scoreAgg._avg.scoreScaled),
  };
}

/** Per-course rollup, including the most recent attempts. */
export async function getCourseAnalytics(
  tenantId: string,
  courseId: string,
  prisma: PrismaClient,
): Promise<CourseAnalytics> {
  const where = { tenantId, courseId };
  const [attemptCount, completionCount, passCount, failCount, agg, recent] = await Promise.all([
    prisma.attempt.count({ where }),
    prisma.attempt.count({ where: { ...where, status: 'COMPLETED' } }),
    prisma.attempt.count({ where: { ...where, successStatus: 'PASSED' } }),
    prisma.attempt.count({ where: { ...where, successStatus: 'FAILED' } }),
    prisma.attempt.aggregate({
      where,
      _avg: { scoreScaled: true, sessionTimeSeconds: true },
    }),
    prisma.attempt.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: RECENT_LIMIT,
      include: {
        objectives: { orderBy: { index: 'asc' } },
        interactions: { orderBy: { index: 'asc' } },
      },
    }),
  ]);

  const decided = passCount + failCount;
  return {
    courseId,
    attemptCount,
    completionCount,
    completionRate: ratio(completionCount, attemptCount),
    averageScore: round(agg._avg.scoreScaled),
    averageTimeSeconds: agg._avg.sessionTimeSeconds != null ? Math.round(agg._avg.sessionTimeSeconds) : null,
    passRate: decided > 0 ? ratio(passCount, decided) : null,
    recentAttempts: recent.map(serializeAttempt),
  };
}

/** Per-learner rollup, keyed by the host LMS's external learner id. */
export async function getLearnerAnalytics(
  tenantId: string,
  learnerExternalId: string,
  prisma: PrismaClient,
): Promise<LearnerAnalytics | null> {
  const learner = await prisma.learner.findUnique({
    where: { tenantId_externalId: { tenantId, externalId: learnerExternalId } },
    select: { id: true },
  });
  if (!learner) return null;

  const where = { tenantId, learnerId: learner.id };
  const [attemptCount, timeAgg, completedCourses, recent] = await Promise.all([
    prisma.attempt.count({ where }),
    prisma.attempt.aggregate({ where, _sum: { sessionTimeSeconds: true } }),
    prisma.attempt.groupBy({
      by: ['courseId'],
      where: { ...where, status: 'COMPLETED' },
    }),
    prisma.attempt.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: RECENT_LIMIT,
      include: {
        objectives: { orderBy: { index: 'asc' } },
        interactions: { orderBy: { index: 'asc' } },
      },
    }),
  ]);

  return {
    learnerId: learnerExternalId,
    attemptCount,
    completedCourseCount: completedCourses.length,
    totalTimeSeconds: timeAgg._sum.sessionTimeSeconds ?? 0,
    recentAttempts: recent.map(serializeAttempt),
  };
}

// ---- helpers ---------------------------------------------------------------

function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return round(part / whole) ?? 0;
}

/** Round to 4 decimal places, preserving null. */
function round(value: number | null | undefined): number | null {
  if (value == null) return null;
  return Math.round(value * 10_000) / 10_000;
}
