/**
 * Attempt tracking: persistence of runtime sessions into the Attempt data model.
 *
 * {@link startOrResumeAttempt} launches or resumes a learner's attempt and
 * yields the {@link import('../runtime/index.js').RuntimeContext} for a session;
 * {@link recordCommit} folds a commit/terminate snapshot back into the database.
 * The pure mapping helpers are re-exported for callers that need to shape
 * runtime data without touching Prisma.
 */
export {
  applyCommit,
  AttemptServiceError,
  getRuntimeState,
  recordCommit,
  startOrResumeAttempt,
} from './attempts.js';
export type {
  ApplyCommitInput,
  ApplyCommitResult,
  RecordCommitInput,
  RuntimeState,
  SetValueIssue,
  StartAttemptInput,
  StartedAttempt,
  ValidationMode,
} from './attempts.js';

export {
  extractInteractions,
  extractObjectives,
  lessonStatusFrom,
  rollupAttempt,
  sessionSeconds,
} from './mapper.js';
export type {
  AttemptRollup,
  InteractionRow,
  ObjectiveRow,
  PrismaCompletionStatus,
  PrismaLessonStatus,
  PrismaSuccessStatus,
} from './mapper.js';
