import type { ScormVersion } from '../../parser/manifest.js';

/**
 * A flat, string-keyed snapshot of a CMI data model — exactly the shape a
 * content package reads and writes via dotted element names
 * (e.g. `cmi.core.lesson_status`). Collection members are stored with their
 * numeric index inline (`cmi.objectives.0.id`). Internal `_count` / `_children`
 * pseudo-elements are never persisted.
 */
export type CmiState = Record<string, string>;

/**
 * Values the LMS injects before launch and the content may read but not write
 * (learner identity, credit, entry, launch data, resumed total time, etc.).
 */
export interface RuntimeContext {
  learnerId: string;
  learnerName: string;
  /** 'credit' | 'no-credit' */
  credit?: string;
  /** '' | 'ab-initio' | 'resume' */
  entry?: string;
  /** 'normal' | 'browse' | 'review' */
  mode?: string;
  launchData?: string;
  masteryScore?: number | null;
  /** Accumulated time from prior attempts, in the edition's timespan format. */
  totalTime?: string;
  scaledPassingScore?: number | null;
  completionThreshold?: number | null;
}

/**
 * A version-specific CMI data model. Reads and writes validate against the
 * edition's element table and controlled vocabularies, throwing
 * {@link import('../errors.js').ScormApiError} with the right numeric code.
 *
 * Lifecycle (Initialize / Terminate / Commit) lives one layer up in the
 * session — the data model is pure state plus validation.
 */
export interface DataModel {
  readonly version: ScormVersion;
  getValue(element: string): string;
  setValue(element: string, value: string): void;
  /** All learner-written (and default) values as a flat snapshot for persistence. */
  export(): CmiState;
  /** Rehydrate a previously exported snapshot (resume). Bypasses read-only guards. */
  import(state: CmiState): void;
  /** Normalized rollup the tracking layer maps onto an Attempt row. */
  summary(): CmiSummary;
}

/** Edition-neutral rollup of the outcome-bearing CMI elements. */
export interface CmiSummary {
  completionStatus: 'completed' | 'incomplete' | 'not attempted' | 'unknown';
  successStatus: 'passed' | 'failed' | 'unknown';
  scoreRaw: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  scoreScaled: number | null;
  progressMeasure: number | null;
  lessonLocation: string | null;
  suspendData: string | null;
  /** Session time reported by the content this session, in the edition's format. */
  sessionTime: string | null;
  /** WO exit request from the content ('suspend', 'normal', …). */
  exit: string | null;
}
