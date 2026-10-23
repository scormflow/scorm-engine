import type { PrismaClient } from '../db/client.js';

/**
 * The learning data an AI insight is grounded in.
 *
 * Built from the most recent attempts (course-scoped or tenant-wide) and
 * reduced to aggregates: outcome rates, where unfinished attempts stopped,
 * the objectives learners fail and the questions they get wrong. No learner
 * id, name or attempt id is ever included — the model sees cohorts, not
 * people.
 */

export const CONTEXT_ATTEMPT_LIMIT = 500;
const TOP_N = 15;
const MAX_TEXT = 160;

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
  return context;
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
