import type { PrismaClient } from '../db/client.js';
import type { CourseHeatmap } from '../replay/heatmap.js';

/**
 * The learning data an AI insight is grounded in.
 *
 * Built from the most recent attempts (course-scoped or tenant-wide) and
 * reduced to aggregates: outcome rates, where unfinished attempts stopped,
 * the objectives learners fail and the questions they get wrong. For a single
 * course it also carries the learner journey from session replay — how many
 * attempts reached each location in course order and where reach falls off.
 * No learner id, name or attempt id is ever included — the model sees
 * cohorts, not people.
 */

export const CONTEXT_ATTEMPT_LIMIT = 500;
/** Attempts whose replay timelines feed the journey (each one is rebuilt from its commit log). */
export const JOURNEY_ATTEMPT_LIMIT = 100;
const TOP_N = 15;
const MAX_TEXT = 160;
const MAX_JOURNEY_LOCATIONS = 40;
const STEEPEST_DROPS = 3;

/** Course heatmap source — the replay service in the app, a stub in tests. */
export type HeatmapLoader = (tenantId: string, courseId: string, limit: number) => Promise<CourseHeatmap>;

export interface JourneyStep {
  location: string;
  /** Attempts that reached the location. */
  reached: number;
  /** `reached` over the journey's attempts. */
  reachRate: number;
  /** Unfinished attempts that stopped here. */
  dropOffs: number;
  /** `dropOffs` over `reached`. */
  dropOffRate: number;
  avgActiveSeconds: number;
  interactions: number;
}

export interface InsightJourney {
  attempts: number;
  completed: number;
  /** Locations in course order (the order attempts first reach them). */
  locations: JourneyStep[];
  /** True when the course has more locations than are listed. */
  truncated: boolean;
  /** Largest falls in reach between consecutive locations, biggest first. */
  steepestDrops: Array<{ after: string; next: string; reachBefore: number; reachAfter: number; drop: number }>;
}

export interface InsightContext {
  scope: 'course' | 'tenant';
  course?: { id: string; title: string; description: string | null; scormVersion: string; masteryScore: number | null };
  sample: { attempts: number; truncated: boolean; from: string | null; to: string | null };
  outcomes: {
    completed: number;
    inProgress: number;
    abandoned: number;
    completionRate: number;
    passed: number;
    failed: number;
    passRate: number | null;
    averageScore: number | null;
    averageSessionMinutes: number | null;
  };
  /** Where attempts that never completed last were (`lesson_location`), most common first. */
  dropOff: Array<{ location: string; attempts: number; share: number }>;
  /** Objectives with a recorded success status, most-failed first. */
  objectives: Array<{ id: string; description: string | null; attempts: number; passed: number; failed: number; passRate: number }>;
  /** Interactions with a result, most-missed first. */
  interactions: Array<{
    id: string;
    description: string | null;
    type: string | null;
    responses: number;
    correct: number;
    incorrect: number;
    correctRate: number;
    commonWrongResponses: string[];
  }>;
  /** Tenant scope only: per-course outcomes, lowest completion first. */
  courses?: Array<{ id: string; title: string; attempts: number; completionRate: number; passRate: number | null }>;
  /** Course scope only, when a heatmap source is available and attempts visited locations. */
  journey?: InsightJourney;
}

export interface InsightContextOptions {
  /** Adds the session-replay journey to course-scoped contexts. */
  heatmap?: HeatmapLoader;
}

interface AttemptRow {
  courseId: string;
  status: string;
  completionStatus: string;
  successStatus: string;
  lessonLocation: string | null;
  scoreScaled: number | null;
  sessionTimeSeconds: number;
  startedAt: Date;
  objectives: Array<{ identifier: string; description: string | null; successStatus: string | null }>;
  interactions: Array<{
    identifier: string;
    description: string | null;
    type: string | null;
    result: string | null;
    learnerResponse: string | null;
  }>;
}

export class InsightContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsightContextError';
  }
}

export async function buildInsightContext(
  prisma: PrismaClient,
  tenantId: string,
  courseId?: string,
  options: InsightContextOptions = {},
): Promise<InsightContext> {
  let course: InsightContext['course'];
  if (courseId) {
    const row = await prisma.course.findFirst({
      where: { id: courseId, tenantId },
      select: { id: true, title: true, description: true, scormVersion: true, masteryScore: true },
    });
    if (!row) throw new InsightContextError('Course not found');
    course = { ...row, description: clip(row.description) };
  }

  const attempts = (await prisma.attempt.findMany({
    where: courseId ? { tenantId, courseId } : { tenantId },
    orderBy: { startedAt: 'desc' },
    take: CONTEXT_ATTEMPT_LIMIT + 1,
    select: {
      courseId: true,
      status: true,
      completionStatus: true,
      successStatus: true,
      lessonLocation: true,
      scoreScaled: true,
      sessionTimeSeconds: true,
      startedAt: true,
      objectives: { select: { identifier: true, description: true, successStatus: true } },
      interactions: {
        select: { identifier: true, description: true, type: true, result: true, learnerResponse: true },
      },
    },
  })) as unknown as AttemptRow[];

  const truncated = attempts.length > CONTEXT_ATTEMPT_LIMIT;
  const sample = truncated ? attempts.slice(0, CONTEXT_ATTEMPT_LIMIT) : attempts;
  const dates = sample.map((a) => new Date(a.startedAt).getTime()).sort((a, b) => a - b);

  const context: InsightContext = {
    scope: courseId ? 'course' : 'tenant',
    ...(course ? { course } : {}),
    sample: {
      attempts: sample.length,
      truncated,
      from: dates.length ? new Date(dates[0]!).toISOString() : null,
      to: dates.length ? new Date(dates[dates.length - 1]!).toISOString() : null,
    },
    outcomes: outcomes(sample),
    dropOff: dropOff(sample),
    objectives: objectiveStats(sample),
    interactions: interactionStats(sample),
  };

  if (!courseId) context.courses = await courseStats(prisma, tenantId, sample);
  else if (options.heatmap && sample.length > 0) {
    const journey = buildJourney(await options.heatmap(tenantId, courseId, JOURNEY_ATTEMPT_LIMIT));
    if (journey) context.journey = journey;
  }
  return context;
}

/** Reduce a course heatmap to the reach funnel the model reasons over; null when nothing was visited. */
export function buildJourney(heatmap: CourseHeatmap): InsightJourney | null {
  if (heatmap.attempts === 0 || heatmap.locations.length === 0) return null;
  const locations = heatmap.locations.slice(0, MAX_JOURNEY_LOCATIONS).map(
    (l): JourneyStep => ({
      location: clip(l.location)!,
      reached: l.attempts,
      reachRate: ratio(l.attempts, heatmap.attempts),
      dropOffs: l.dropOffs,
      dropOffRate: ratio(l.dropOffs, l.attempts),
      avgActiveSeconds: l.avgActiveSeconds,
      interactions: l.interactions,
    }),
  );
  const steepestDrops = locations
    .slice(1)
    .map((next, i) => {
      const before = locations[i]!;
      return {
        after: before.location,
        next: next.location,
        reachBefore: before.reachRate,
        reachAfter: next.reachRate,
        drop: round(before.reachRate - next.reachRate),
      };
    })
    .filter((d) => d.drop > 0)
    .sort((a, b) => b.drop - a.drop)
    .slice(0, STEEPEST_DROPS);
  return {
    attempts: heatmap.attempts,
    completed: heatmap.completed,
    locations,
    truncated: heatmap.locations.length > locations.length,
    steepestDrops,
  };
}

function isCompleted(a: AttemptRow): boolean {
  return a.status === 'COMPLETED' || a.completionStatus === 'COMPLETED';
}

function outcomes(sample: AttemptRow[]): InsightContext['outcomes'] {
  const completed = sample.filter(isCompleted).length;
  const inProgress = sample.filter((a) => a.status === 'IN_PROGRESS' && !isCompleted(a)).length;
  const passed = sample.filter((a) => a.successStatus === 'PASSED').length;
  const failed = sample.filter((a) => a.successStatus === 'FAILED').length;
  const scores = sample.map((a) => a.scoreScaled).filter((s): s is number => s != null);
  const times = sample.map((a) => a.sessionTimeSeconds).filter((t) => t > 0);
  return {
    completed,
    inProgress,
    abandoned: sample.length - completed - inProgress,
    completionRate: ratio(completed, sample.length),
    passed,
    failed,
    passRate: passed + failed > 0 ? ratio(passed, passed + failed) : null,
    averageScore: scores.length ? round(scores.reduce((s, v) => s + v, 0) / scores.length) : null,
    averageSessionMinutes: times.length ? round(times.reduce((s, v) => s + v, 0) / times.length / 60, 1) : null,
  };
}

function dropOff(sample: AttemptRow[]): InsightContext['dropOff'] {
  const unfinished = sample.filter((a) => !isCompleted(a));
  const counts = new Map<string, number>();
  for (const a of unfinished) {
    const location = a.lessonLocation?.trim();
    if (location) counts.set(clip(location)!, (counts.get(clip(location)!) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([location, attempts]) => ({ location, attempts, share: ratio(attempts, unfinished.length) }));
}

function objectiveStats(sample: AttemptRow[]): InsightContext['objectives'] {
  const stats = new Map<string, { description: string | null; attempts: number; passed: number; failed: number }>();
  for (const a of sample) {
    for (const o of a.objectives ?? []) {
      if (o.successStatus !== 'PASSED' && o.successStatus !== 'FAILED') continue;
      const s = stats.get(o.identifier) ?? { description: clip(o.description), attempts: 0, passed: 0, failed: 0 };
      s.attempts++;
      if (o.successStatus === 'PASSED') s.passed++;
      else s.failed++;
      stats.set(o.identifier, s);
    }
  }
  return [...stats]
    .map(([id, s]) => ({ id: clip(id)!, ...s, passRate: ratio(s.passed, s.attempts) }))
    .sort((a, b) => b.failed - a.failed || a.passRate - b.passRate)
    .slice(0, TOP_N);
}

function interactionStats(sample: AttemptRow[]): InsightContext['interactions'] {
  const stats = new Map<
    string,
    { description: string | null; type: string | null; correct: number; incorrect: number; wrong: Map<string, number> }
  >();
  for (const a of sample) {
    for (const i of a.interactions ?? []) {
      const result = i.result?.toLowerCase();
      const correct = result === 'correct';
      const incorrect = result === 'incorrect' || result === 'wrong';
      if (!correct && !incorrect) continue;
      const s = stats.get(i.identifier) ?? {
        description: clip(i.description),
        type: i.type,
        correct: 0,
        incorrect: 0,
        wrong: new Map<string, number>(),
      };
      if (correct) s.correct++;
      else {
        s.incorrect++;
        const response = clip(i.learnerResponse?.trim(), 80);
        if (response) s.wrong.set(response, (s.wrong.get(response) ?? 0) + 1);
      }
      stats.set(i.identifier, s);
    }
  }
  return [...stats]
    .map(([id, s]) => ({
      id: clip(id)!,
      description: s.description,
      type: s.type,
      responses: s.correct + s.incorrect,
      correct: s.correct,
      incorrect: s.incorrect,
      correctRate: ratio(s.correct, s.correct + s.incorrect),
      commonWrongResponses: [...s.wrong]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([r]) => r),
    }))
    .sort((a, b) => b.incorrect - a.incorrect || a.correctRate - b.correctRate)
    .slice(0, TOP_N);
}

async function courseStats(
  prisma: PrismaClient,
  tenantId: string,
  sample: AttemptRow[],
): Promise<NonNullable<InsightContext['courses']>> {
  const byCourse = new Map<string, AttemptRow[]>();
  for (const a of sample) byCourse.set(a.courseId, [...(byCourse.get(a.courseId) ?? []), a]);
  if (byCourse.size === 0) return [];
  const titles = await prisma.course.findMany({
    where: { tenantId, id: { in: [...byCourse.keys()] } },
    select: { id: true, title: true },
  });
  const titleOf = new Map(titles.map((c) => [c.id, c.title]));
  return [...byCourse]
    .map(([id, rows]) => {
      const o = outcomes(rows);
      return { id, title: clip(titleOf.get(id) ?? id)!, attempts: rows.length, completionRate: o.completionRate, passRate: o.passRate };
    })
    .sort((a, b) => a.completionRate - b.completionRate)
    .slice(0, TOP_N);
}

function clip(value: string | null | undefined, max = MAX_TEXT): string | null {
  if (value == null) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? round(part / whole) : 0;
}

function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
