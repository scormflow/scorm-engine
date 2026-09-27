/**
 * Attempt lifecycle service: the bridge between HTTP requests, the runtime
 * session, and the database.
 *
 * Responsibilities:
 *  - start a fresh attempt or resume the learner's open one for a SCO,
 *  - build the read-only {@link RuntimeContext} the runtime session launches with,
 *  - persist a commit/terminate snapshot into the Attempt + child tables.
 *
 * The runtime session itself is held per-request by the caller; this service is
 * stateless and only touches Prisma.
 */
import type { PrismaClient } from '../db/client.js';
import type { ScormVersion } from '../parser/manifest.js';
import type { CmiState, CmiSummary, RuntimeContext } from '../runtime/datamodel/types.js';
import { secondsToIso8601 } from '../runtime/datamodel/validators.js';
import {
  extractInteractions,
  extractObjectives,
  rollupAttempt,
  type AttemptRollup,
} from './mapper.js';

export class AttemptServiceError extends Error {
  constructor(
    message: string,
    public readonly code: 'course_not_found' | 'attempt_not_found' | 'attempt_finished',
    public readonly status: 404 | 409 = 404,
  ) {
    super(message);
    this.name = 'AttemptServiceError';
  }
}

export interface StartAttemptInput {
  tenantId: string;
  courseId: string;
  scoId?: string | undefined;
  learnerExternalId: string;
  learnerName?: string | undefined;
  mode?: string | undefined;
  /** Force a brand-new attempt even if a resumable one exists. */
  restart?: boolean;
}

export interface StartedAttempt {
  attemptId: string;
  resumed: boolean;
  version: ScormVersion;
  context: RuntimeContext;
  /** Previously-committed CMI snapshot to resume from, or undefined for a new attempt. */
  resumeState: CmiState | undefined;
}

const SPEC_VERSION: Record<string, ScormVersion> = {
  SCORM_12: 'SCORM_1_2',
  SCORM_2004_2: 'SCORM_2004_2',
  SCORM_2004_3: 'SCORM_2004_3',
  SCORM_2004_4: 'SCORM_2004_4',
};

/**
 * Start a new attempt, or resume the learner's still-open attempt for this
 * course/SCO. A resumed attempt returns its last committed CMI snapshot and an
 * `entry` of `resume`; a fresh attempt starts `ab-initio`.
 */
export async function startOrResumeAttempt(
  input: StartAttemptInput,
  prisma: PrismaClient,
): Promise<StartedAttempt> {
  const course = await prisma.course.findFirst({
    where: { id: input.courseId, tenantId: input.tenantId },
    select: { id: true, scormVersion: true, masteryScore: true },
  });
  if (!course) {
    throw new AttemptServiceError('Course not found', 'course_not_found');
  }
  const version = SPEC_VERSION[course.scormVersion] ?? 'SCORM_1_2';

  const learner = await upsertLearner(prisma, input.tenantId, input.learnerExternalId, input.learnerName);

  const existing = input.restart
    ? null
    : await prisma.attempt.findFirst({
        where: {
          tenantId: input.tenantId,
          courseId: input.courseId,
          learnerId: learner.id,
          scoId: input.scoId ?? null,
          status: 'IN_PROGRESS',
        },
        orderBy: { startedAt: 'desc' },
      });

  const priorTotalSeconds = await accumulatedSeconds(
    prisma,
    input.tenantId,
    input.courseId,
    learner.id,
    existing?.id,
  );

  const baseContext: RuntimeContext = {
    learnerId: input.learnerExternalId,
    learnerName: input.learnerName ?? input.learnerExternalId,
    credit: 'credit',
    mode: input.mode ?? 'normal',
    masteryScore: course.masteryScore,
    totalTime: formatTotalTime(priorTotalSeconds, version),
  };

  if (existing) {
    return {
      attemptId: existing.id,
      resumed: true,
      version,
      context: { ...baseContext, entry: 'resume' },
      resumeState: (existing.cmiSnapshot as CmiState) ?? undefined,
    };
  }

  const created = await prisma.attempt.create({
    data: {
      tenantId: input.tenantId,
      courseId: input.courseId,
      learnerId: learner.id,
      scoId: input.scoId ?? null,
      status: 'IN_PROGRESS',
      totalTimeSeconds: priorTotalSeconds,
    },
    select: { id: true },
  });

  return {
    attemptId: created.id,
    resumed: false,
    version,
    context: { ...baseContext, entry: 'ab-initio' },
    resumeState: undefined,
  };
}

export interface RecordCommitInput {
  tenantId: string;
  attemptId: string;
  state: CmiState;
  summary: CmiSummary;
  version: ScormVersion;
  /** When true, the attempt is closed out (Terminate) rather than left open. */
  terminal?: boolean;
}

/**
 * Persist a commit (or terminate) snapshot: update the scalar Attempt columns,
 * replace the objective/interaction child rows, append a commit-log entry, and
 * fold the session time into the running total.
 */
export async function recordCommit(input: RecordCommitInput, prisma: PrismaClient): Promise<void> {
  const attempt = await prisma.attempt.findFirst({
    where: { id: input.attemptId, tenantId: input.tenantId },
    select: { id: true, status: true, tenantId: true, courseId: true, learnerId: true },
  });
  if (!attempt) {
    throw new AttemptServiceError('Attempt not found', 'attempt_not_found');
  }
  if (attempt.status !== 'IN_PROGRESS') {
    throw new AttemptServiceError('Attempt is already finished', 'attempt_finished', 409);
  }

  const rollup = rollupAttempt(input.summary, input.version);
  const objectives = extractObjectives(input.state, input.version);
  const interactions = extractInteractions(input.state, input.version);

  // The content reports session_time cumulatively, so each commit's session
  // value fully replaces the previous one. The grand total is therefore the
  // fixed prior-attempt total plus the current (cumulative) session time —
  // recomputed here so re-commits never double-count.
  const priorSeconds = await accumulatedSeconds(
    prisma,
    attempt.tenantId,
    attempt.courseId,
    attempt.learnerId,
    attempt.id,
  );
  const totalTimeSeconds = priorSeconds + rollup.sessionTimeSeconds;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.attempt.update({
      where: { id: attempt.id },
      data: {
        ...attemptColumns(rollup),
        sessionTimeSeconds: rollup.sessionTimeSeconds,
        totalTimeSeconds,
        cmiSnapshot: input.state as Record<string, string>,
        status: input.terminal ? terminalStatus(rollup) : 'IN_PROGRESS',
        lastCommitAt: now,
        finishedAt: input.terminal ? now : null,
      },
    });

    await tx.objective.deleteMany({ where: { attemptId: attempt.id } });
    if (objectives.length > 0) {
      await tx.objective.createMany({
        data: objectives.map((o) => ({ attemptId: attempt.id, ...o })),
      });
    }

    await tx.interaction.deleteMany({ where: { attemptId: attempt.id } });
    if (interactions.length > 0) {
      await tx.interaction.createMany({
        data: interactions.map((i) => ({ attemptId: attempt.id, ...i })),
      });
    }

    await tx.commitLog.create({
      data: { attemptId: attempt.id, values: input.state as Record<string, string> },
    });
  });
}

// ---- helpers ---------------------------------------------------------------

function attemptColumns(rollup: AttemptRollup) {
  return {
    lessonStatus: rollup.lessonStatus,
    completionStatus: rollup.completionStatus,
    successStatus: rollup.successStatus,
    lessonLocation: rollup.lessonLocation,
    suspendData: rollup.suspendData,
    scoreRaw: rollup.scoreRaw,
    scoreMin: rollup.scoreMin,
    scoreMax: rollup.scoreMax,
    scoreScaled: rollup.scoreScaled,
    progressMeasure: rollup.progressMeasure,
  };
}

function terminalStatus(rollup: AttemptRollup): 'COMPLETED' | 'TERMINATED' {
  return rollup.completionStatus === 'COMPLETED' ? 'COMPLETED' : 'TERMINATED';
}

async function upsertLearner(
  prisma: PrismaClient,
  tenantId: string,
  externalId: string,
  name: string | undefined,
): Promise<{ id: string }> {
  return prisma.learner.upsert({
    where: { tenantId_externalId: { tenantId, externalId } },
    create: { tenantId, externalId, name: name ?? null },
    update: name ? { name } : {},
    select: { id: true },
  });
}

/** Sum session time across the learner's *finished* attempts (excluding `exceptId`). */
async function accumulatedSeconds(
  prisma: PrismaClient,
  tenantId: string,
  courseId: string,
  learnerId: string,
  exceptId: string | undefined,
): Promise<number> {
  const rows = await prisma.attempt.findMany({
    where: {
      tenantId,
      courseId,
      learnerId,
      status: { in: ['COMPLETED', 'TERMINATED', 'EXPIRED'] },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { sessionTimeSeconds: true },
  });
  return rows.reduce((sum, r) => sum + (r.sessionTimeSeconds ?? 0), 0);
}

function formatTotalTime(seconds: number, version: ScormVersion): string {
  if (version === 'SCORM_1_2') {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${String(h).padStart(4, '0')}:${pad(m)}:${pad(s)}`;
  }
  return secondsToIso8601(seconds);
}
