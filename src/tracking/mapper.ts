/**
 * Pure translation between the runtime CMI layer and the persistence schema.
 *
 * Everything here is side-effect free: it takes a {@link CmiSummary} / {@link CmiState}
 * plus the course's SCORM version and returns plain rows the attempts service
 * writes with Prisma. Keeping it pure makes the interesting logic — enum
 * mapping, score/time rollup, collection extraction — unit-testable without a
 * database.
 */
import type { ScormVersion } from '../parser/manifest.js';
import type { CmiState, CmiSummary } from '../runtime/datamodel/types.js';
import { iso8601ToSeconds, scorm12ToCentis } from '../runtime/datamodel/validators.js';

export type PrismaLessonStatus =
  | 'PASSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'INCOMPLETE'
  | 'BROWSED'
  | 'NOT_ATTEMPTED';
export type PrismaCompletionStatus = 'COMPLETED' | 'INCOMPLETE' | 'NOT_ATTEMPTED' | 'UNKNOWN';
export type PrismaSuccessStatus = 'PASSED' | 'FAILED' | 'UNKNOWN';

/** The scalar Attempt columns derived from a commit/terminate snapshot. */
export interface AttemptRollup {
  lessonStatus: PrismaLessonStatus;
  completionStatus: PrismaCompletionStatus;
  successStatus: PrismaSuccessStatus;
  lessonLocation: string | null;
  suspendData: string | null;
  scoreRaw: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  scoreScaled: number | null;
  progressMeasure: number | null;
  /** Elapsed seconds reported by the content this session. */
  sessionTimeSeconds: number;
}

export interface ObjectiveRow {
  index: number;
  identifier: string;
  scoreRaw: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  scoreScaled: number | null;
  successStatus: PrismaSuccessStatus | null;
  completionStatus: PrismaCompletionStatus | null;
  progressMeasure: number | null;
  description: string | null;
}

export interface InteractionRow {
  index: number;
  identifier: string;
  type: string | null;
  learnerResponse: string | null;
  correctResponse: string | null;
  result: string | null;
  weighting: number | null;
  latencySeconds: number | null;
  description: string | null;
}

const is2004 = (v: ScormVersion): boolean => v !== 'SCORM_1_2';

/**
 * Roll a session summary up into the scalar Attempt columns. The success and
 * completion axes are independent in 2004 but conflated into `lesson_status`
 * in 1.2 — {@link lessonStatusFrom} reconciles them into the legacy column so a
 * single query shape works across both editions.
 */
export function rollupAttempt(summary: CmiSummary, version: ScormVersion): AttemptRollup {
  return {
    lessonStatus: lessonStatusFrom(summary),
    completionStatus: completionStatusFor(summary.completionStatus),
    successStatus: successStatusFor(summary.successStatus),
    lessonLocation: summary.lessonLocation,
    suspendData: summary.suspendData,
    scoreRaw: summary.scoreRaw,
    scoreMin: summary.scoreMin,
    scoreMax: summary.scoreMax,
    scoreScaled: summary.scoreScaled,
    progressMeasure: summary.progressMeasure,
    sessionTimeSeconds: sessionSeconds(summary.sessionTime, version),
  };
}

/** Parse the edition's session-time format into whole seconds (0 when absent). */
export function sessionSeconds(sessionTime: string | null, version: ScormVersion): number {
  if (!sessionTime) return 0;
  return is2004(version)
    ? Math.round(iso8601ToSeconds(sessionTime))
    : Math.round(scorm12ToCentis(sessionTime) / 100);
}

function completionStatusFor(s: CmiSummary['completionStatus']): PrismaCompletionStatus {
  switch (s) {
    case 'completed':
      return 'COMPLETED';
    case 'incomplete':
      return 'INCOMPLETE';
    case 'not attempted':
      return 'NOT_ATTEMPTED';
    default:
      return 'UNKNOWN';
  }
}

function successStatusFor(s: CmiSummary['successStatus']): PrismaSuccessStatus {
  switch (s) {
    case 'passed':
      return 'PASSED';
    case 'failed':
      return 'FAILED';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Collapse the (success, completion) pair into a single legacy lesson_status.
 * Success wins when known (passed/failed are terminal outcomes); otherwise we
 * fall back to the completion axis.
 */
export function lessonStatusFrom(summary: CmiSummary): PrismaLessonStatus {
  if (summary.successStatus === 'passed') return 'PASSED';
  if (summary.successStatus === 'failed') return 'FAILED';
  switch (summary.completionStatus) {
    case 'completed':
      return 'COMPLETED';
    case 'incomplete':
      return 'INCOMPLETE';
    case 'not attempted':
      return 'NOT_ATTEMPTED';
    default:
      return 'NOT_ATTEMPTED';
  }
}

/** Extract objective rows from a flat CMI snapshot, ordered by their index. */
export function extractObjectives(state: CmiState, version: ScormVersion): ObjectiveRow[] {
  const prefix = 'cmi.objectives.';
  const indices = collectionIndices(state, prefix);
  const rows: ObjectiveRow[] = [];
  for (const i of indices) {
    const id = state[`${prefix}${i}.id`];
    if (!id) continue; // an objective without an id is not persistable
    rows.push(
      is2004(version)
        ? {
            index: i,
            identifier: id,
            scoreRaw: num(state[`${prefix}${i}.score.raw`]),
            scoreMin: num(state[`${prefix}${i}.score.min`]),
            scoreMax: num(state[`${prefix}${i}.score.max`]),
            scoreScaled: num(state[`${prefix}${i}.score.scaled`]),
            successStatus: successFromStatus(state[`${prefix}${i}.success_status`]),
            completionStatus: completionFromStatus(state[`${prefix}${i}.completion_status`]),
            progressMeasure: num(state[`${prefix}${i}.progress_measure`]),
            description: state[`${prefix}${i}.description`] ?? null,
          }
        : {
            index: i,
            identifier: id,
            scoreRaw: num(state[`${prefix}${i}.score.raw`]),
            scoreMin: num(state[`${prefix}${i}.score.min`]),
            scoreMax: num(state[`${prefix}${i}.score.max`]),
            scoreScaled: null,
            successStatus: successFromLessonStatus(state[`${prefix}${i}.status`]),
            completionStatus: completionFromLessonStatus(state[`${prefix}${i}.status`]),
            progressMeasure: null,
            description: null,
          },
    );
  }
  return rows;
}

/** Extract interaction rows from a flat CMI snapshot, ordered by their index. */
export function extractInteractions(state: CmiState, version: ScormVersion): InteractionRow[] {
  const prefix = 'cmi.interactions.';
  const indices = collectionIndices(state, prefix);
  const responseKey = is2004(version) ? 'learner_response' : 'student_response';
  const rows: InteractionRow[] = [];
  for (const i of indices) {
    const id = state[`${prefix}${i}.id`];
    if (!id) continue;
    rows.push({
      index: i,
      identifier: id,
      type: state[`${prefix}${i}.type`] ?? null,
      learnerResponse: state[`${prefix}${i}.${responseKey}`] ?? null,
      correctResponse: state[`${prefix}${i}.correct_responses.0.pattern`] ?? null,
      result: state[`${prefix}${i}.result`] ?? null,
      weighting: num(state[`${prefix}${i}.weighting`]),
      latencySeconds: latencySeconds(state[`${prefix}${i}.latency`], version),
      description: state[`${prefix}${i}.description`] ?? null,
    });
  }
  return rows;
}

// ---- helpers ---------------------------------------------------------------

function collectionIndices(state: CmiState, prefix: string): number[] {
  const seen = new Set<number>();
  for (const key of Object.keys(state)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const dot = rest.indexOf('.');
    const idx = Number(dot === -1 ? rest : rest.slice(0, dot));
    if (Number.isInteger(idx) && idx >= 0) seen.add(idx);
  }
  return [...seen].sort((a, b) => a - b);
}

function latencySeconds(raw: string | undefined, version: ScormVersion): number | null {
  if (!raw) return null;
  return is2004(version) ? iso8601ToSeconds(raw) : scorm12ToCentis(raw) / 100;
}

function num(v: string | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function successFromStatus(s: string | undefined): PrismaSuccessStatus | null {
  if (s === 'passed') return 'PASSED';
  if (s === 'failed') return 'FAILED';
  if (s === 'unknown') return 'UNKNOWN';
  return null;
}

function completionFromStatus(s: string | undefined): PrismaCompletionStatus | null {
  if (s === 'completed') return 'COMPLETED';
  if (s === 'incomplete') return 'INCOMPLETE';
  if (s === 'not attempted') return 'NOT_ATTEMPTED';
  if (s === 'unknown') return 'UNKNOWN';
  return null;
}

function successFromLessonStatus(s: string | undefined): PrismaSuccessStatus | null {
  if (s === 'passed') return 'PASSED';
  if (s === 'failed') return 'FAILED';
  return null;
}

function completionFromLessonStatus(s: string | undefined): PrismaCompletionStatus | null {
  switch (s) {
    case 'passed':
    case 'completed':
    case 'failed':
      return 'COMPLETED';
    case 'incomplete':
    case 'browsed':
      return 'INCOMPLETE';
    case 'not attempted':
      return 'NOT_ATTEMPTED';
    default:
      return null;
  }
}
