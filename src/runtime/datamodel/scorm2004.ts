import type { ScormVersion } from '../../parser/manifest.js';
import { Scorm2004ErrorCode as E, ScormApiError } from '../errors.js';
import type { CmiState, CmiSummary, DataModel, RuntimeContext } from './types.js';
import {
  isBoundedString,
  isCmiDecimal,
  isDecimalInRange,
  isInVocabulary,
  isIso8601DateTime,
  isScorm2004Duration,
} from './validators.js';

const COMPLETION_STATUS = ['completed', 'incomplete', 'not attempted', 'unknown'] as const;
const SUCCESS_STATUS = ['passed', 'failed', 'unknown'] as const;
const EXIT_VOCAB = ['time-out', 'suspend', 'logout', 'normal', ''] as const;
const INTERACTION_TYPES = [
  'true-false', 'choice', 'fill-in', 'long-fill-in', 'matching',
  'performance', 'sequencing', 'likert', 'numeric', 'other',
] as const;

const SCORE_CHILDREN = 'scaled,raw,min,max';
const OBJECTIVE_CHILDREN =
  'id,score,success_status,completion_status,progress_measure,description';
const INTERACTION_CHILDREN =
  'id,type,objectives,timestamp,correct_responses,weighting,learner_response,result,latency,description';

/**
 * SCORM 2004 CMI data model (`API_1484_11`).
 *
 * Splits the 1.2 `lesson_status` into independent `completion_status` and
 * `success_status`, adds `score.scaled` (−1..1) and `progress_measure` (0..1),
 * and uses ISO 8601 durations for time. Read-only launch context is served from
 * {@link RuntimeContext}; learner-written values live in a flat map.
 */
export class Scorm2004DataModel implements DataModel {
  readonly version: ScormVersion;
  private readonly state = new Map<string, string>();

  constructor(
    private readonly ctx: RuntimeContext,
    version: ScormVersion = 'SCORM_2004_4',
  ) {
    this.version = version;
    this.state.set('cmi.completion_status', 'unknown');
    this.state.set('cmi.success_status', 'unknown');
  }

  getValue(element: string): string {
    const keyword = this.readKeyword(element);
    if (keyword !== undefined) return keyword;

    switch (element) {
      case 'cmi._version':
        return '1.0';
      case 'cmi.learner_id':
        return this.ctx.learnerId;
      case 'cmi.learner_name':
        return this.ctx.learnerName;
      case 'cmi.credit':
        return this.ctx.credit ?? 'credit';
      case 'cmi.entry':
        return this.ctx.entry ?? 'ab-initio';
      case 'cmi.mode':
        return this.ctx.mode ?? 'normal';
      case 'cmi.total_time':
        return this.ctx.totalTime ?? 'PT0S';
      case 'cmi.launch_data':
        return this.ctx.launchData ?? '';
      case 'cmi.scaled_passing_score':
        return this.ctx.scaledPassingScore != null ? String(this.ctx.scaledPassingScore) : '';
      case 'cmi.completion_threshold':
        return this.ctx.completionThreshold != null ? String(this.ctx.completionThreshold) : '';
      case 'cmi.max_time_allowed':
      case 'cmi.time_limit_action':
        return this.state.get(element) ?? '';
      case 'cmi.exit':
      case 'cmi.session_time':
        throw new ScormApiError(E.ElementWriteOnly, `${element} is write-only`, element);
    }

    if (this.isReadableStored(element)) {
      const v = this.state.get(element);
      if (v !== undefined) return v;
      // Reading a defined element that was never set is error 403 in 2004.
      throw new ScormApiError(E.ValueNotInitialized, `${element} has not been initialized`, element);
    }

    throw new ScormApiError(E.UndefinedDataModelElement, `Undefined data model element: ${element}`, element);
  }

  setValue(element: string, value: string): void {
    switch (element) {
      case 'cmi.location':
        return this.store(element, value, (v) => isBoundedString(v, 1000));
      case 'cmi.completion_status':
        return this.store(element, value, (v) => isInVocabulary(v, COMPLETION_STATUS));
      case 'cmi.success_status':
        return this.store(element, value, (v) => isInVocabulary(v, SUCCESS_STATUS));
      case 'cmi.progress_measure':
        return this.store(element, value, (v) => isDecimalInRange(v, 0, 1), E.ValueOutOfRange);
      case 'cmi.score.scaled':
        return this.store(element, value, (v) => isDecimalInRange(v, -1, 1), E.ValueOutOfRange);
      case 'cmi.score.raw':
      case 'cmi.score.min':
      case 'cmi.score.max':
        return this.store(element, value, (v) => v === '' || isCmiDecimal(v));
      case 'cmi.exit':
        return this.store(element, value, (v) => isInVocabulary(v, EXIT_VOCAB));
      case 'cmi.session_time':
        return this.store(element, value, isScorm2004Duration);
      case 'cmi.suspend_data':
        return this.store(element, value, (v) => isBoundedString(v, 64000));
    }

    if (this.setCollectionValue(element, value)) return;

    if (this.isReadOnly(element)) {
      throw new ScormApiError(E.ElementReadOnly, `${element} is read-only`, element);
    }
    if (element.endsWith('._children') || element.endsWith('._count')) {
      throw new ScormApiError(E.ElementReadOnly, `${element} is a keyword and cannot be set`, element);
    }
    throw new ScormApiError(E.UndefinedDataModelElement, `Undefined data model element: ${element}`, element);
  }

  export(): CmiState {
    return Object.fromEntries(this.state);
  }

  import(state: CmiState): void {
    for (const [k, v] of Object.entries(state)) this.state.set(k, v);
  }

  summary(): CmiSummary {
    const completion = this.state.get('cmi.completion_status') ?? 'unknown';
    const success = this.state.get('cmi.success_status') ?? 'unknown';
    return {
      completionStatus: isInVocabulary(completion, COMPLETION_STATUS)
        ? (completion as CmiSummary['completionStatus'])
        : 'unknown',
      successStatus: isInVocabulary(success, SUCCESS_STATUS)
        ? (success as CmiSummary['successStatus'])
        : 'unknown',
      scoreRaw: numeric(this.state.get('cmi.score.raw')),
      scoreMin: numeric(this.state.get('cmi.score.min')),
      scoreMax: numeric(this.state.get('cmi.score.max')),
      scoreScaled: numeric(this.state.get('cmi.score.scaled')),
      progressMeasure: numeric(this.state.get('cmi.progress_measure')),
      lessonLocation: this.state.get('cmi.location') ?? null,
      suspendData: this.state.get('cmi.suspend_data') ?? null,
      sessionTime: this.state.get('cmi.session_time') ?? null,
      exit: this.state.get('cmi.exit') ?? null,
    };
  }

  // ---- internals -----------------------------------------------------------

  private store(
    element: string,
    value: string,
    valid: (v: string) => boolean,
    failCode: number = E.TypeMismatch,
  ): void {
    if (!valid(value)) {
      throw new ScormApiError(failCode, `Invalid value for ${element}: "${value}"`, element);
    }
    this.state.set(element, value);
  }

  private readKeyword(element: string): string | undefined {
    switch (element) {
      case 'cmi.score._children':
        return SCORE_CHILDREN;
      case 'cmi.objectives._children':
        return OBJECTIVE_CHILDREN;
      case 'cmi.interactions._children':
        return INTERACTION_CHILDREN;
      case 'cmi.objectives._count':
        return String(this.collectionCount('cmi.objectives'));
      case 'cmi.interactions._count':
        return String(this.collectionCount('cmi.interactions'));
    }
    const nested = /^(cmi\.interactions\.\d+\.(?:correct_responses|objectives))\._count$/.exec(element);
    if (nested) return String(this.collectionCount(nested[1]!));
    return undefined;
  }

  private setCollectionValue(element: string, value: string): boolean {
    const obj = /^cmi\.objectives\.(\d+)\.(.+)$/.exec(element);
    if (obj) {
      const field = obj[2]!;
      if (field === 'id') this.store(element, value, (v) => v.length > 0 && isBoundedString(v, 4000));
      else if (field === 'success_status') this.store(element, value, (v) => isInVocabulary(v, SUCCESS_STATUS));
      else if (field === 'completion_status')
        this.store(element, value, (v) => isInVocabulary(v, COMPLETION_STATUS));
      else if (field === 'progress_measure')
        this.store(element, value, (v) => isDecimalInRange(v, 0, 1), E.ValueOutOfRange);
      else if (field === 'score.scaled')
        this.store(element, value, (v) => isDecimalInRange(v, -1, 1), E.ValueOutOfRange);
      else if (field === 'score.raw' || field === 'score.min' || field === 'score.max')
        this.store(element, value, (v) => v === '' || isCmiDecimal(v));
      else if (field === 'description') this.store(element, value, (v) => isBoundedString(v, 250));
      else return false;
      return true;
    }

    const inter = /^cmi\.interactions\.(\d+)\.(.+)$/.exec(element);
    if (inter) {
      const field = inter[2]!;
      if (field === 'id') this.store(element, value, (v) => v.length > 0 && isBoundedString(v, 4000));
      else if (field === 'type') this.store(element, value, (v) => isInVocabulary(v, INTERACTION_TYPES));
      else if (field === 'timestamp') this.store(element, value, isIso8601DateTime);
      else if (field === 'weighting') this.store(element, value, isCmiDecimal);
      else if (field === 'learner_response') this.store(element, value, (v) => isBoundedString(v, 4000));
      else if (field === 'result')
        this.store(element, value, (v) => /^(correct|incorrect|unanticipated|neutral|-?\d+(\.\d+)?)$/.test(v));
      else if (field === 'latency') this.store(element, value, isScorm2004Duration);
      else if (field === 'description') this.store(element, value, (v) => isBoundedString(v, 250));
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
      element === 'cmi.location' ||
      element === 'cmi.completion_status' ||
      element === 'cmi.success_status' ||
      element === 'cmi.progress_measure' ||
      element === 'cmi.suspend_data' ||
      element.startsWith('cmi.score.') ||
      element.startsWith('cmi.objectives.') ||
      element.startsWith('cmi.interactions.')
    );
  }

  private isReadOnly(element: string): boolean {
    return (
      element === 'cmi._version' ||
      element === 'cmi.learner_id' ||
      element === 'cmi.learner_name' ||
      element === 'cmi.credit' ||
      element === 'cmi.entry' ||
      element === 'cmi.mode' ||
      element === 'cmi.total_time' ||
      element === 'cmi.launch_data' ||
      element === 'cmi.scaled_passing_score' ||
      element === 'cmi.completion_threshold' ||
      element === 'cmi.max_time_allowed'
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
