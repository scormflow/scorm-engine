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
import { ScormApiError } from '../runtime/errors.js';
import { createDataModel, RuntimeSession } from '../runtime/session.js';
import type { CmiState, CmiSummary, RuntimeContext } from '../runtime/datamodel/types.js';
import { secondsToIso8601 } from '../runtime/datamodel/validators.js';
import type { EventSink } from '../webhooks/events.js';
import { isCertificateEligible } from '../certificates/service.js';
import { attemptTransitionEvents, masteredObjectives } from './events.js';
import {
  extractInteractions,
  extractObjectives,
  rollupAttempt,
  sessionSeconds,
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
  restart?: boolean | undefined;
  /** Told about a newly created attempt (`attempt.started`). */
  events?: EventSink | undefined;
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
  // A resumed attempt also carries the sessions it banked before suspending.
  const bankedSeconds = existing
    ? sessionSeconds(
        ((existing.cmiSnapshot as CmiState | null) ?? {})[timeKeys(version).totalTime] ?? null,
        version,
      )
    : 0;

  const baseContext: RuntimeContext = {
    learnerId: input.learnerExternalId,
    learnerName: input.learnerName ?? input.learnerExternalId,
    credit: 'credit',
    mode: input.mode ?? 'normal',
    masteryScore: course.masteryScore,
    totalTime: formatTotalTime(priorTotalSeconds + bankedSeconds, version),
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

  input.events?.emit(input.tenantId, 'attempt.started', {
    attemptId: created.id,
    courseId: input.courseId,
    scoId: input.scoId ?? null,
    learnerId: input.learnerExternalId,
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
  terminal?: boolean | undefined;
  /** Told about the completion / success / score transitions this commit makes. */
  events?: EventSink | undefined;
  /** Client sequence number (offline sync); recorded as the attempt's `lastCommitSeq`. */
  seq?: number | undefined;
  /** When the client originally recorded the commit (offline sync). */
  recordedAt?: Date | undefined;
  /** Issues the attempt's certificate once it becomes completed and not failed. */
  certificates?: CertificateHook | undefined;
}

/** What the tracking service needs from the certificate engine. Must not throw. */
export interface CertificateHook {
  issueAfterCommit(tenantId: string, attemptId: string): Promise<void>;
}

export interface RuntimeState {
  attemptId: string;
  version: ScormVersion;
  status: string;
  /** CMI snapshot keyed by SCORM-native paths; empty for a never-committed attempt. */
  cmi: CmiState;
  entry: 'ab-initio' | 'resume';
  learner: { id: string; name: string | null };
  /** Highest client commit `seq` applied so far, or null if none carried one. */
  lastCommitSeq: number | null;
}

/**
 * Read the runtime state a player needs to (re)hydrate a SCO: the CMI snapshot,
 * the course's SCORM version, and the entry mode. Entry is `resume` once the
 * attempt has any committed CMI, otherwise `ab-initio`.
 */
export async function getRuntimeState(
  tenantId: string,
  attemptId: string,
  prisma: PrismaClient,
): Promise<RuntimeState | null> {
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId, tenantId },
    select: {
      id: true,
      status: true,
      cmiSnapshot: true,
      lastCommitSeq: true,
      course: { select: { scormVersion: true } },
      learner: { select: { externalId: true, name: true } },
    },
  });
  if (!attempt) return null;

  const cmi = (attempt.cmiSnapshot as CmiState) ?? {};
  return {
    attemptId: attempt.id,
    version: SPEC_VERSION[attempt.course.scormVersion] ?? 'SCORM_1_2',
    status: attempt.status,
    cmi,
    entry: Object.keys(cmi).length > 0 ? 'resume' : 'ab-initio',
    learner: { id: attempt.learner.externalId, name: attempt.learner.name ?? null },
    lastCommitSeq: attempt.lastCommitSeq ?? null,
  };
}

/**
 * Persist a commit (or terminate) snapshot: update the scalar Attempt columns,
 * replace the objective/interaction child rows, append a commit-log entry, and
 * fold the session time into the running total.
 *
 * A terminal commit whose `exit` is `suspend` only suspends: the attempt stays
 * `IN_PROGRESS`, the session time is banked as `total_time`, and the next
 * launch resumes it with its location and suspend_data intact.
 */
export async function recordCommit(
  input: RecordCommitInput,
  prisma: PrismaClient,
): Promise<{ suspended: boolean }> {
  const attempt = await prisma.attempt.findFirst({
    where: { id: input.attemptId, tenantId: input.tenantId },
    select: {
      id: true,
      status: true,
      tenantId: true,
      courseId: true,
      learnerId: true,
      scoId: true,
      completionStatus: true,
      successStatus: true,
      scoreRaw: true,
      scoreMin: true,
      scoreMax: true,
      scoreScaled: true,
      cmiSnapshot: true,
      learner: { select: { externalId: true } },
      objectives: { select: { identifier: true, successStatus: true } },
    },
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
  // Terminate with exit=suspend ends the *session*, not the attempt: the
  // attempt stays open so the next launch resumes it.
  const suspended = Boolean(input.terminal) && isSuspendExit(input.summary.exit);
  const finished = Boolean(input.terminal) && !suspended;

  // The content reports session_time cumulatively, so each commit's session
  // value fully replaces the previous one. Sessions that ended in a suspend are
  // banked in the snapshot's total_time, so the attempt's time is that bank
  // plus the current (cumulative) session time, and the grand total adds the
  // learner's earlier attempts — recomputed here so re-commits never double-count.
  const keys = timeKeys(input.version);
  const previous = (attempt.cmiSnapshot as CmiState | null) ?? {};
  const bankedSeconds = sessionSeconds(previous[keys.totalTime] ?? null, input.version);
  const attemptSeconds = bankedSeconds + rollup.sessionTimeSeconds;
  const priorSeconds = await accumulatedSeconds(
    prisma,
    attempt.tenantId,
    attempt.courseId,
    attempt.learnerId,
    attempt.id,
  );
  const totalTimeSeconds = priorSeconds + attemptSeconds;
  const now = new Date();

  // total_time is engine-owned: never persist whatever the content tried to write.
  const snapshot: CmiState = { ...input.state };
  delete snapshot[keys.totalTime];
  if (suspended) {
    // The next session starts with a fresh session_time and exit.
    delete snapshot[keys.sessionTime];
    delete snapshot[keys.exit];
    snapshot[keys.totalTime] = formatTotalTime(attemptSeconds, input.version);
  } else if (bankedSeconds > 0) {
    snapshot[keys.totalTime] = formatTotalTime(bankedSeconds, input.version);
  }

  await prisma.$transaction(async (tx) => {
    await tx.attempt.update({
      where: { id: attempt.id },
      data: {
        ...attemptColumns(rollup),
        sessionTimeSeconds: attemptSeconds,
        totalTimeSeconds,
        cmiSnapshot: snapshot as Record<string, string>,
        status: finished ? terminalStatus(rollup) : 'IN_PROGRESS',
        lastCommitAt: now,
        finishedAt: finished ? now : null,
        ...(input.seq !== undefined ? { lastCommitSeq: input.seq } : {}),
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
      data: {
        attemptId: attempt.id,
        values: input.state as Record<string, string>,
        seq: input.seq ?? null,
        recordedAt: input.recordedAt ?? null,
      },
    });
  });

  if (input.events) {
    const types = attemptTransitionEvents(
      {
        completionStatus: attempt.completionStatus ?? 'UNKNOWN',
        successStatus: attempt.successStatus ?? 'UNKNOWN',
        scoreRaw: attempt.scoreRaw ?? null,
        scoreMin: attempt.scoreMin ?? null,
        scoreMax: attempt.scoreMax ?? null,
        scoreScaled: attempt.scoreScaled ?? null,
      },
      rollup,
      finished,
    );
    if (suspended) types.push('attempt.suspended');
    const data = {
      attemptId: attempt.id,
      courseId: attempt.courseId,
      scoId: attempt.scoId ?? null,
      learnerId: attempt.learner?.externalId ?? null,
      completionStatus: rollup.completionStatus,
      successStatus: rollup.successStatus,
      score: { raw: rollup.scoreRaw, min: rollup.scoreMin, max: rollup.scoreMax, scaled: rollup.scoreScaled },
      totalTimeSeconds,
    };
    for (const type of types) input.events.emit(attempt.tenantId, type, data);

    for (const o of masteredObjectives(attempt.objectives ?? [], objectives)) {
      input.events.emit(attempt.tenantId, 'objective.mastered', {
        attemptId: attempt.id,
        courseId: attempt.courseId,
        scoId: attempt.scoId ?? null,
        learnerId: attempt.learner?.externalId ?? null,
        objective: {
          id: o.identifier,
          index: o.index,
          successStatus: o.successStatus,
          completionStatus: o.completionStatus,
          score: { raw: o.scoreRaw, min: o.scoreMin, max: o.scoreMax, scaled: o.scoreScaled },
        },
      });
    }
  }

  // Issue when the attempt first qualifies, and re-check when it finishes (a
  // no-op if it already has one) in case an earlier issue failed.
  const wasEligible = isCertificateEligible({
    completionStatus: attempt.completionStatus ?? null,
    successStatus: attempt.successStatus ?? null,
  });
  if (input.certificates && isCertificateEligible(rollup) && (!wasEligible || finished)) {
    await input.certificates.issueAfterCommit(attempt.tenantId, attempt.id);
  }

  return { suspended };
}

/**
 * How the runtime treats CMI writes that fail data-model validation.
 * See {@link ApplyCommitInput.mode} / `SCORM_VALIDATION_MODE`.
 */
export type ValidationMode = 'lenient' | 'strict';

export interface ApplyCommitInput {
  tenantId: string;
  attemptId: string;
  /** Batched SetValue pairs, applied in order. */
  values: Array<[element: string, value: string]>;
  /** When true, Terminate the session (final commit); otherwise Commit. */
  terminate?: boolean | undefined;
  /** Validation policy; defaults to 'lenient'. */
  mode?: ValidationMode | undefined;
  events?: EventSink | undefined;
  /**
   * Client-assigned, strictly increasing commit sequence number (offline sync).
   * A commit whose `seq` is at or below the attempt's `lastCommitSeq` was
   * already applied and is acknowledged as a duplicate without replaying it.
   */
  seq?: number | undefined;
  /** When the client originally recorded the commit, if it was queued offline. */
  recordedAt?: Date | undefined;
  certificates?: CertificateHook | undefined;
}

export interface SetValueIssue {
  element: string;
  code: number;
  message: string;
}

export interface ApplyCommitResult {
  /**
   * Rejected writes (strict mode). The valid writes in the batch still persist;
   * an error means that specific element was not stored.
   */
  errors: SetValueIssue[];
  /**
   * Accepted-but-nonconformant writes (lenient mode). The value was persisted
   * as-is despite failing validation, mirroring certified-LMS behavior.
   */
  warnings: SetValueIssue[];
  summary: CmiSummary;
  state: CmiState;
  /** True when the attempt was finalized (a terminate without exit=suspend). */
  terminated: boolean;
  /** True when a terminate with exit=suspend left the attempt open to resume. */
  suspended: boolean;
  /** True when `seq` showed the commit was already applied; nothing was written. */
  duplicate: boolean;
}

/**
 * Replay a batch of SetValue calls against a server-side {@link RuntimeSession}
 * seeded from the attempt's last snapshot, then persist the result.
 *
 * Every write is validated by the real data model. What happens to a failed
 * write depends on {@link ApplyCommitInput.mode}:
 *  - `lenient` (default): the raw value is still persisted and reported as a
 *    warning — real-world SCORM content routinely violates the spec and a
 *    certified LMS keeps it working rather than rejecting the commit.
 *  - `strict`: the write is dropped and reported as an error, for conformance
 *    testing content against the spec.
 *
 * Either way the commit as a whole succeeds; a single bad write never aborts it.
 */
export async function applyCommit(
  input: ApplyCommitInput,
  prisma: PrismaClient,
): Promise<ApplyCommitResult> {
  const attempt = await prisma.attempt.findFirst({
    where: { id: input.attemptId, tenantId: input.tenantId },
    select: {
      id: true,
      status: true,
      cmiSnapshot: true,
      lastCommitSeq: true,
      course: { select: { scormVersion: true, masteryScore: true } },
      learner: { select: { externalId: true, name: true } },
    },
  });
  if (!attempt) {
    throw new AttemptServiceError('Attempt not found', 'attempt_not_found');
  }
  const version = SPEC_VERSION[attempt.course.scormVersion] ?? 'SCORM_1_2';
  // Replayed offline commit: acknowledge it (even if it was the one that
  // finished the attempt) so the client can drop it from its queue.
  if (isDuplicateSeq(input.seq, attempt.lastCommitSeq)) {
    const current = createDataModel(version, launchContext(attempt, 'resume'));
    current.import((attempt.cmiSnapshot as CmiState) ?? {});
    return {
      errors: [],
      warnings: [],
      summary: current.summary(),
      state: current.export(),
      terminated: false,
      suspended: false,
      duplicate: true,
    };
  }
  if (attempt.status !== 'IN_PROGRESS') {
    throw new AttemptServiceError('Attempt is already finished', 'attempt_finished', 409);
  }

  const session = new RuntimeSession({
    version,
    context: launchContext(attempt, 'resume'),
    resumeState: (attempt.cmiSnapshot as CmiState) ?? undefined,
  });
  session.initialize();

  const mode: ValidationMode = input.mode ?? 'lenient';
  const errors: SetValueIssue[] = [];
  const warnings: SetValueIssue[] = [];
  // In lenient mode, values that fail validation are still persisted verbatim,
  // so hold them aside to merge into the snapshot after the model commits.
  const rejected: Array<[string, string]> = [];

  for (const [element, value] of input.values) {
    try {
      session.setValue(element, value);
    } catch (err) {
      if (!(err instanceof ScormApiError)) throw err;
      const issue: SetValueIssue = { element, code: err.code, message: err.message };
      if (mode === 'strict') {
        errors.push(issue);
      } else {
        warnings.push(issue);
        rejected.push([element, value]);
      }
    }
  }

  const snapshot = input.terminate ? session.terminate() : session.commit();
  // Lenient: overlay the raw non-conformant writes so they round-trip on resume.
  // Rollup/summary intentionally stay derived from the validated model only.
  for (const [element, value] of rejected) snapshot.state[element] = value;

  const { suspended } = await recordCommit(
    {
      tenantId: input.tenantId,
      attemptId: input.attemptId,
      state: snapshot.state,
      summary: snapshot.summary,
      version,
      terminal: input.terminate,
      events: input.events,
      seq: input.seq,
      recordedAt: input.recordedAt,
      certificates: input.certificates,
    },
    prisma,
  );

  return {
    errors,
    warnings,
    summary: snapshot.summary,
    state: snapshot.state,
    terminated: Boolean(input.terminate) && !suspended,
    suspended,
    duplicate: false,
  };
}

/** One commit recorded by a client while offline, replayed by {@link syncCommits}. */
export interface QueuedCommit {
  seq: number;
  values: Array<[element: string, value: string]>;
  terminate?: boolean | undefined;
  recordedAt?: Date | undefined;
}

export interface SyncCommitsInput {
  tenantId: string;
  attemptId: string;
  commits: QueuedCommit[];
  mode?: ValidationMode | undefined;
  events?: EventSink | undefined;
  certificates?: CertificateHook | undefined;
}

/**
 * Per-commit reconciliation outcome:
 *  - `applied`: replayed and persisted now,
 *  - `duplicate`: an earlier sync already applied it (safe to drop),
 *  - `conflict`: the attempt was already finished, so it can never apply.
 */
export type SyncCommitStatus = 'applied' | 'duplicate' | 'conflict';

export interface SyncCommitOutcome {
  seq: number;
  status: SyncCommitStatus;
  errors: SetValueIssue[];
  warnings: SetValueIssue[];
  terminated: boolean;
  suspended: boolean;
}

export interface SyncCommitsResult {
  /** The attempt's `lastCommitSeq` after reconciliation. */
  lastCommitSeq: number | null;
  results: SyncCommitOutcome[];
  /** Rollup after the last applied (or duplicate) commit; null if none got that far. */
  summary: CmiSummary | null;
}

/**
 * Reconcile a client's offline commit queue: replay the commits in `seq` order
 * through {@link applyCommit}. Commits already applied by an earlier (possibly
 * interrupted) sync are skipped as duplicates, so a client can resend its whole
 * queue after a dropped connection without double-applying anything. Once the
 * attempt is finished (a terminate in the batch, or before it), every later
 * commit is reported as a `conflict` — server state wins.
 */
export async function syncCommits(
  input: SyncCommitsInput,
  prisma: PrismaClient,
): Promise<SyncCommitsResult> {
  const ordered = [...input.commits].sort((a, b) => a.seq - b.seq);
  const seen = new Set<number>();
  const results: SyncCommitOutcome[] = [];
  let summary: CmiSummary | null = null;

  for (const commit of ordered) {
    const base = { seq: commit.seq, errors: [], warnings: [], terminated: false, suspended: false };
    if (seen.has(commit.seq)) {
      results.push({ ...base, status: 'duplicate' });
      continue;
    }
    seen.add(commit.seq);
    try {
      const result = await applyCommit(
        {
          tenantId: input.tenantId,
          attemptId: input.attemptId,
          values: commit.values,
          terminate: commit.terminate,
          mode: input.mode,
          events: input.events,
          seq: commit.seq,
          recordedAt: commit.recordedAt,
          certificates: input.certificates,
        },
        prisma,
      );
      summary = result.summary;
      results.push({
        seq: commit.seq,
        status: result.duplicate ? 'duplicate' : 'applied',
        errors: result.errors,
        warnings: result.warnings,
        terminated: result.terminated,
        suspended: result.suspended,
      });
    } catch (err) {
      if (err instanceof AttemptServiceError && err.code === 'attempt_finished') {
        results.push({ ...base, status: 'conflict' });
        continue;
      }
      throw err;
    }
  }

  const state = await getRuntimeState(input.tenantId, input.attemptId, prisma);
  if (!state) throw new AttemptServiceError('Attempt not found', 'attempt_not_found');
  return { lastCommitSeq: state.lastCommitSeq, results, summary };
}

// ---- helpers ---------------------------------------------------------------

function isDuplicateSeq(seq: number | undefined, lastCommitSeq: number | null | undefined): boolean {
  return seq !== undefined && lastCommitSeq !== null && lastCommitSeq !== undefined && seq <= lastCommitSeq;
}

/** The read-only launch context a commit replays under. */
function launchContext(
  attempt: { learner: { externalId: string; name: string | null }; course: { masteryScore: number | null } },
  entry: 'ab-initio' | 'resume',
): RuntimeContext {
  return {
    learnerId: attempt.learner.externalId,
    learnerName: attempt.learner.name ?? attempt.learner.externalId,
    credit: 'credit',
    mode: 'normal',
    entry,
    masteryScore: attempt.course.masteryScore,
  };
}

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

function isSuspendExit(exit: string | null): boolean {
  return exit === 'suspend';
}

/** The edition's CMI paths for the time and exit elements. */
function timeKeys(version: ScormVersion): { totalTime: string; sessionTime: string; exit: string } {
  return version === 'SCORM_1_2'
    ? { totalTime: 'cmi.core.total_time', sessionTime: 'cmi.core.session_time', exit: 'cmi.core.exit' }
    : { totalTime: 'cmi.total_time', sessionTime: 'cmi.session_time', exit: 'cmi.exit' };
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
