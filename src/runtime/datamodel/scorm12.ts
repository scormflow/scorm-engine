import type { ScormVersion } from '../../parser/manifest.js';
import { Scorm12ErrorCode as E, ScormApiError } from '../errors.js';
import type { CmiState, CmiSummary, DataModel, RuntimeContext } from './types.js';
import {
  isBoundedString,
  isDecimalInRange,
  isInVocabulary,
  isScorm12Timespan,
} from './validators.js';

const LESSON_STATUS = ['passed', 'completed', 'failed', 'incomplete', 'browsed', 'not attempted'] as const;
const EXIT_VOCAB = ['time-out', 'suspend', 'logout', ''] as const;
const PREF_TEXT = ['-1', '0', '1'] as const;

const CORE_CHILDREN =
  'student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time';
const SCORE_CHILDREN = 'raw,min,max';
const OBJECTIVE_CHILDREN = 'id,score,status';
const INTERACTION_CHILDREN =
  'id,objectives,time,type,correct_responses,weighting,student_response,result,latency';
const STUDENT_DATA_CHILDREN = 'mastery_score,max_time_allowed,time_limit_action';
const STUDENT_PREF_CHILDREN = 'audio,language,speed,text';

/**
 * SCORM 1.2 CMI data model (`cmi.core.*`).
 *
 * Read-only launch context (student identity, credit, entry, total_time) is
 * served from {@link RuntimeContext}; everything the SCO writes lives in a flat
 * key→value map so it round-trips cleanly through {@link export}/{@link import}.
 */
export class Scorm12DataModel implements DataModel {
  readonly version: ScormVersion;
  private readonly state = new Map<string, string>();

  constructor(
    private readonly ctx: RuntimeContext,
    version: ScormVersion = 'SCORM_1_2',
  ) {
    this.version = version;
    this.state.set('cmi.core.lesson_status', 'not attempted');
  }

  getValue(element: string): string {
    // Keyword (_children / _count) reads.
    const keyword = this.readKeyword(element);
    if (keyword !== undefined) return keyword;

    switch (element) {
      case 'cmi.core.student_id':
        return this.ctx.learnerId;
      case 'cmi.core.student_name':
        return this.ctx.learnerName;
      case 'cmi.core.credit':
        return this.ctx.credit ?? 'credit';
      case 'cmi.core.entry':
        return this.ctx.entry ?? 'ab-initio';
      case 'cmi.core.lesson_mode':
        return this.ctx.mode ?? 'normal';
      case 'cmi.core.total_time':
        return this.ctx.totalTime ?? '0000:00:00';
      case 'cmi.launch_data':
        return this.ctx.launchData ?? '';
      case 'cmi.comments_from_lms':
        return this.state.get(element) ?? '';
      case 'cmi.student_data.mastery_score':
        return this.ctx.masteryScore != null ? String(this.ctx.masteryScore) : '';
      case 'cmi.student_data.max_time_allowed':
      case 'cmi.student_data.time_limit_action':
        return this.state.get(element) ?? '';
      case 'cmi.core.exit':
      case 'cmi.core.session_time':
        // Write-only per the spec.
        throw new ScormApiError(E.ElementWriteOnly, `${element} is write-only`, element);
    }

    if (this.isReadableStored(element)) {
      const v = this.state.get(element);
      if (v !== undefined) return v;
      // A defined-but-unset element reads as empty string in 1.2.
      if (this.isKnownElement(element)) return '';
    }

    throw new ScormApiError(E.NotImplemented, `Unsupported data model element: ${element}`, element);
  }

  setValue(element: string, value: string): void {
    switch (element) {
      case 'cmi.core.lesson_location':
        return this.store(element, value, (v) => isBoundedString(v, 255));
      case 'cmi.core.lesson_status':
        return this.store(element, value, (v) => isInVocabulary(v, LESSON_STATUS));
      case 'cmi.core.score.raw':
      case 'cmi.core.score.min':
      case 'cmi.core.score.max':
        return this.store(element, value, (v) => v === '' || isDecimalInRange(v, 0, 100));
      case 'cmi.core.exit':
        return this.store(element, value, (v) => isInVocabulary(v, EXIT_VOCAB));
      case 'cmi.core.session_time':
        return this.store(element, value, isScorm12Timespan);
      case 'cmi.suspend_data':
        return this.store(element, value, (v) => isBoundedString(v, 4096));
      case 'cmi.comments':
        return this.store(element, value, (v) => isBoundedString(v, 4096));
      case 'cmi.student_preference.audio':
      case 'cmi.student_preference.speed':
        return this.store(element, value, (v) => /^-?\d+$/.test(v));
      case 'cmi.student_preference.language':
        return this.store(element, value, (v) => isBoundedString(v, 255));
      case 'cmi.student_preference.text':
        return this.store(element, value, (v) => isInVocabulary(v, PREF_TEXT));
    }

    if (this.setCollectionValue(element, value)) return;

    // Read-only elements rejected explicitly for a precise error code.
    if (this.isReadOnly(element)) {
      throw new ScormApiError(E.ElementReadOnly, `${element} is read-only`, element);
    }
    if (element.endsWith('._children') || element.endsWith('._count')) {
      throw new ScormApiError(E.ElementReadOnly, `${element} is a keyword and cannot be set`, element);
    }
    throw new ScormApiError(E.NotImplemented, `Unsupported data model element: ${element}`, element);
  }

  export(): CmiState {
    return Object.fromEntries(this.state);
  }

  import(state: CmiState): void {
    for (const [k, v] of Object.entries(state)) this.state.set(k, v);
  }

  summary(): CmiSummary {
    const status = this.state.get('cmi.core.lesson_status') ?? 'not attempted';
    return {
      completionStatus: mapCompletion(status),
      successStatus: mapSuccess(status),
      scoreRaw: numeric(this.state.get('cmi.core.score.raw')),
      scoreMin: numeric(this.state.get('cmi.core.score.min')),
      scoreMax: numeric(this.state.get('cmi.core.score.max')),
      scoreScaled: null,
      progressMeasure: null,
      lessonLocation: this.state.get('cmi.core.lesson_location') ?? null,
      suspendData: this.state.get('cmi.suspend_data') ?? null,
      sessionTime: this.state.get('cmi.core.session_time') ?? null,
      exit: this.state.get('cmi.core.exit') ?? null,
    };
  }

  // ---- internals -----------------------------------------------------------

  private store(element: string, value: string, valid: (v: string) => boolean): void {
    if (!valid(value)) {
      throw new ScormApiError(E.IncorrectDataType, `Invalid value for ${element}: "${value}"`, element);
    }
    this.state.set(element, value);
  }

  private readKeyword(element: string): string | undefined {
    switch (element) {
      case 'cmi.core._children':
        return CORE_CHILDREN;
      case 'cmi.core.score._children':
        return SCORE_CHILDREN;
      case 'cmi.objectives._children':
        return OBJECTIVE_CHILDREN;
      case 'cmi.interactions._children':
        return INTERACTION_CHILDREN;
      case 'cmi.student_data._children':
        return STUDENT_DATA_CHILDREN;
      case 'cmi.student_preference._children':
        return STUDENT_PREF_CHILDREN;
      case 'cmi.objectives._count':
        return String(this.collectionCount('cmi.objectives'));
      case 'cmi.interactions._count':
        return String(this.collectionCount('cmi.interactions'));
    }
    // Nested per-interaction counts, e.g. cmi.interactions.0.correct_responses._count
    const nested = /^(cmi\.interactions\.\d+\.(?:correct_responses|objectives))\._count$/.exec(element);
    if (nested) return String(this.collectionCount(nested[1]!));
    return undefined;
  }

  /**
   * Handle writes into the objectives and interactions arrays. Returns true if
   * the element was recognised (and stored), false to let the caller fall
   * through to its unsupported-element handling.
   */
  private setCollectionValue(element: string, value: string): boolean {
    const obj = /^cmi\.objectives\.(\d+)\.(id|status|score\.(?:raw|min|max))$/.exec(element);
    if (obj) {
      const field = obj[2]!;
      if (field === 'id') this.store(element, value, (v) => isBoundedString(v, 255) && v.length > 0);
      else if (field === 'status') this.store(element, value, (v) => isInVocabulary(v, LESSON_STATUS));
      else this.store(element, value, (v) => v === '' || isDecimalInRange(v, 0, 100));
      return true;
    }

    const inter = /^cmi\.interactions\.(\d+)\.(.+)$/.exec(element);
    if (inter) {
      const field = inter[2]!;
      if (field === 'id') this.store(element, value, (v) => v.length > 0 && isBoundedString(v, 255));
      else if (field === 'time') this.store(element, value, (v) => /^\d{2}:\d{2}:\d{2}(\.\d{1,2})?$/.test(v));
      else if (field === 'type')
        this.store(element, value, (v) =>
          isInVocabulary(v, ['true-false', 'choice', 'fill-in', 'matching', 'performance', 'sequencing', 'likert', 'numeric']),
        );
      else if (field === 'weighting') this.store(element, value, (v) => /^-?\d+(\.\d+)?$/.test(v));
      else if (field === 'student_response') this.store(element, value, (v) => isBoundedString(v, 255));
      else if (field === 'result')
        this.store(element, value, (v) => /^(correct|wrong|unanticipated|neutral|-?\d+(\.\d+)?)$/.test(v));
      else if (field === 'latency') this.store(element, value, isScorm12Timespan);
      else if (/^objectives\.\d+\.id$/.test(field)) this.store(element, value, (v) => v.length > 0);
      else if (/^correct_responses\.\d+\.pattern$/.test(field)) this.store(element, value, (v) => v.length > 0);
      else return false;
      return true;
    }

    return false;
  }

  private collectionCount(prefix: string): number {
    let max = -1;
    for (const key of this.state.keys()) {
      const m = new RegExp(`^${escapeRegExp(prefix)}\\.(\\d+)\\.`).exec(key);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  private isReadableStored(element: string): boolean {
    return (
      element.startsWith('cmi.objectives.') ||
      element.startsWith('cmi.student_preference.') ||
      element === 'cmi.core.lesson_location' ||
      element === 'cmi.core.lesson_status' ||
      element === 'cmi.core.score.raw' ||
      element === 'cmi.core.score.min' ||
      element === 'cmi.core.score.max' ||
      element === 'cmi.suspend_data' ||
      element === 'cmi.comments'
    );
  }

  private isKnownElement(element: string): boolean {
    return this.isReadableStored(element);
  }

  private isReadOnly(element: string): boolean {
    return (
      element === 'cmi.core.student_id' ||
      element === 'cmi.core.student_name' ||
      element === 'cmi.core.credit' ||
      element === 'cmi.core.entry' ||
      element === 'cmi.core.lesson_mode' ||
      element === 'cmi.core.total_time' ||
      element === 'cmi.launch_data' ||
      element === 'cmi.comments_from_lms' ||
      element.startsWith('cmi.student_data.')
    );
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function numeric(v: string | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapCompletion(status: string): CmiSummary['completionStatus'] {
  switch (status) {
    case 'completed':
    case 'passed':
    case 'failed':
      return 'completed';
    case 'incomplete':
    case 'browsed':
      return 'incomplete';
    case 'not attempted':
      return 'not attempted';
    default:
      return 'unknown';
  }
}

function mapSuccess(status: string): CmiSummary['successStatus'] {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}
