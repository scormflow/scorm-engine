/**
 * SCORM Run-Time Environment (RTE).
 *
 * A server-authoritative implementation of the ADL API data model for both
 * SCORM 1.2 (`cmi.core.*`) and SCORM 2004 (`API_1484_11`). The {@link RuntimeSession}
 * is the entry point: construct one per launched attempt, drive it with the
 * ADL verbs, and persist the snapshot it returns from `commit()` / `terminate()`.
 */
export { RuntimeSession, createDataModel } from './session.js';
export type { SessionOptions, SessionPhase } from './session.js';

export { Scorm12DataModel } from './datamodel/scorm12.js';
export { Scorm2004DataModel } from './datamodel/scorm2004.js';
export type { CmiState, CmiSummary, DataModel, RuntimeContext } from './datamodel/types.js';

export {
  ScormApiError,
  Scorm12ErrorCode,
  Scorm2004ErrorCode,
} from './errors.js';
export type { ScormErrorCode } from './errors.js';

export {
  addScorm12Timespans,
  addScorm2004Durations,
  iso8601ToSeconds,
  scorm12ToCentis,
  secondsToIso8601,
} from './datamodel/validators.js';
