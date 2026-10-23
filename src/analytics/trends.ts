/**
 * Time-series and distribution read models for dashboard widgets.
 *
 * Prisma cannot group by calendar day portably (SQLite in dev, Postgres in
 * production), so these pull a narrow column projection for the requested
 * window and bucket it in memory. Windows are capped at {@link MAX_TREND_DAYS}
 * days, which keeps the projection bounded.
 */
import type { PrismaClient } from '../db/client.js';

export const DEFAULT_TREND_DAYS = 30;
export const MAX_TREND_DAYS = 365;
export const DEFAULT_SCORE_BINS = 10;
export const MIN_SCORE_BINS = 2;
export const MAX_SCORE_BINS = 20;

const DAY_MS = 86_400_000;

export interface TrendBucket {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Attempts started on this day. */
  started: number;
  /** Attempts that reached `COMPLETED` on this day (by finish / last commit time). */
  completed: number;
  passed: number;
  failed: number;
  /** Mean scaled score of the attempts completed on this day. */
  averageScore: number | null;
}

export interface AnalyticsTrends {
  courseId: string | null;
  interval: 'day';
  from: string;
  to: string;
  buckets: TrendBucket[];
  totals: { started: number; completed: number; passed: number; failed: number };
}

export interface ScoreBin {
  /** Inclusive lower bound (scaled score). */
  min: number;
  /** Exclusive upper bound, except the last bin which includes 1. */
  max: number;
  count: number;
}

export interface ScoreDistribution {
  courseId: string;
  scoredCount: number;
  averageScore: number | null;
  medianScore: number | null;
  bins: ScoreBin[];
}

export interface TrendOptions {
  days?: number | undefined;
  courseId?: string | undefined;
  /** End of the window (defaults to now); the window covers `days` UTC days ending on this day. */
  now?: Date | undefined;
}

interface TrendRow {
  status: string;
  successStatus: string;
  scoreScaled: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  lastCommitAt: Date | null;
}

/** Daily started / completed / passed / failed counts for the last `days` days. */
export async function getTrends(
  tenantId: string,
  prisma: PrismaClient,
  options: TrendOptions = {},
): Promise<AnalyticsTrends> {
  const days = options.days ?? DEFAULT_TREND_DAYS;
  const end = startOfUtcDay(options.now ?? new Date());
  const from = new Date(end.getTime() - (days - 1) * DAY_MS);

  const scope = { tenantId, ...(options.courseId ? { courseId: options.courseId } : {}) };
  const rows = (await prisma.attempt.findMany({
    where: {
      ...scope,
      OR: [{ startedAt: { gte: from } }, { finishedAt: { gte: from } }, { lastCommitAt: { gte: from } }],
    },
    select: {
      status: true,
      successStatus: true,
      scoreScaled: true,
      startedAt: true,
      finishedAt: true,
      lastCommitAt: true,
    },
  })) as TrendRow[];

  const buckets: TrendBucket[] = [];
  const scoreSums: Array<{ sum: number; n: number }> = [];
  for (let i = 0; i < days; i++) {
    buckets.push({
      date: isoDay(new Date(from.getTime() + i * DAY_MS)),
      started: 0,
      completed: 0,
      passed: 0,
      failed: 0,
      averageScore: null,
    });
    scoreSums.push({ sum: 0, n: 0 });
  }
  const indexOf = (at: Date | null): number => {
    if (!at) return -1;
    const i = Math.floor((startOfUtcDay(at).getTime() - from.getTime()) / DAY_MS);
    return i >= 0 && i < days ? i : -1;
  };

  for (const row of rows) {
    const started = indexOf(new Date(row.startedAt));
    if (started >= 0) buckets[started]!.started++;

    if (row.status !== 'COMPLETED') continue;
    const doneAt = row.finishedAt ?? row.lastCommitAt;
    const done = indexOf(doneAt ? new Date(doneAt) : null);
    if (done < 0) continue;
    const bucket = buckets[done]!;
    bucket.completed++;
    if (row.successStatus === 'PASSED') bucket.passed++;
    if (row.successStatus === 'FAILED') bucket.failed++;
    if (row.scoreScaled != null) {
      scoreSums[done]!.sum += row.scoreScaled;
      scoreSums[done]!.n++;
    }
  }

  const totals = { started: 0, completed: 0, passed: 0, failed: 0 };
  buckets.forEach((b, i) => {
    const s = scoreSums[i]!;
    b.averageScore = s.n > 0 ? round(s.sum / s.n) : null;
    totals.started += b.started;
    totals.completed += b.completed;
    totals.passed += b.passed;
    totals.failed += b.failed;
  });

  return {
    courseId: options.courseId ?? null,
    interval: 'day',
    from: isoDay(from),
    to: isoDay(end),
    buckets,
    totals,
  };
}

/** Histogram of scaled scores across a course's scored attempts. */
export async function getScoreDistribution(
  tenantId: string,
  courseId: string,
  prisma: PrismaClient,
  bins: number = DEFAULT_SCORE_BINS,
): Promise<ScoreDistribution> {
  const rows = (await prisma.attempt.findMany({
    where: { tenantId, courseId, scoreScaled: { not: null } },
    select: { scoreScaled: true },
  })) as Array<{ scoreScaled: number | null }>;

  const scores = rows
    .map((r) => r.scoreScaled)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s))
    .sort((a, b) => a - b);

  // SCORM 2004 allows scaled scores in [-1, 1]; the histogram covers [0, 1]
  // and clamps anything outside into the end bins. Average / median use the
  // raw values so they agree with `/analytics/courses/{id}`.
  const width = 1 / bins;
  const out: ScoreBin[] = Array.from({ length: bins }, (_, i) => ({
    min: round(i * width)!,
    max: round((i + 1) * width)!,
    count: 0,
  }));
  for (const s of scores) {
    const clamped = Math.min(1, Math.max(0, s));
    out[Math.min(bins - 1, Math.floor(clamped / width))]!.count++;
  }

  return {
    courseId,
    scoredCount: scores.length,
    averageScore: scores.length ? round(scores.reduce((t, s) => t + s, 0) / scores.length) : null,
    medianScore: scores.length ? round(median(scores)) : null,
    bins: out,
  };
}

// ---- helpers ---------------------------------------------------------------

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Median of an ascending-sorted, non-empty array. */
function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Round to 4 decimal places, preserving null. */
function round(value: number | null | undefined): number | null {
  if (value == null) return null;
  return Math.round(value * 10_000) / 10_000;
}
