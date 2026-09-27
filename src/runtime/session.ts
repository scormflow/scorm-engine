import type { ScormVersion } from '../parser/manifest.js';
import { Scorm12ErrorCode as E12, Scorm2004ErrorCode as E04, ScormApiError } from './errors.js';
import { Scorm12DataModel } from './datamodel/scorm12.js';
import { Scorm2004DataModel } from './datamodel/scorm2004.js';
import type { CmiState, CmiSummary, DataModel, RuntimeContext } from './datamodel/types.js';

export type SessionPhase = 'not_initialized' | 'running' | 'terminated';

export interface SessionOptions {
  version: ScormVersion;
  context: RuntimeContext;
  /** Previously-persisted CMI state to resume from. */
  resumeState?: CmiState;
}

/**
 * A server-side SCORM RTE session: the lifecycle state machine that wraps a
 * version-specific {@link DataModel}. It mirrors the ADL API signature
 * (`Initialize` / `GetValue` / `SetValue` / `Commit` / `Terminate`) so a thin
 * browser adapter can proxy each call to the server, while the server stays the
 * authority on validation, ordering, and persistence.
 *
 * Every method returns a value or throws {@link ScormApiError}; the transport
 * layer maps a throw to `"false"` + a `GetLastError()` code, matching the
 * ADL contract where the content never sees exceptions directly.
 */
export class RuntimeSession {
  readonly version: ScormVersion;
  private readonly model: DataModel;
  private readonly is2004: boolean;
  private phase: SessionPhase = 'not_initialized';
  /** True once a SetValue has landed since the last Commit. */
  private dirty = false;

  constructor(opts: SessionOptions) {
    this.version = opts.version;
    this.is2004 = opts.version !== 'SCORM_1_2';
    this.model = createDataModel(opts.version, opts.context);
    if (opts.resumeState) this.model.import(opts.resumeState);
  }

  get state(): SessionPhase {
    return this.phase;
  }

  /** ADL `Initialize("")`. */
  initialize(): void {
    if (this.phase === 'running') {
      throw new ScormApiError(
        this.is2004 ? E04.AlreadyInitialized : E12.GeneralException,
        'Session is already initialized',
      );
    }
    if (this.phase === 'terminated') {
      throw new ScormApiError(
        this.is2004 ? E04.ContentInstanceTerminated : E12.GeneralException,
        'Session has already been terminated',
      );
    }
    this.phase = 'running';
  }

  getValue(element: string): string {
    if (this.phase === 'not_initialized') {
      throw new ScormApiError(
        this.is2004 ? E04.RetrieveDataBeforeInitialization : E12.NotInitialized,
        `GetValue("${element}") called before Initialize`,
        element,
      );
    }
    if (this.phase === 'terminated') {
      throw new ScormApiError(
        this.is2004 ? E04.RetrieveDataAfterTermination : E12.NotInitialized,
        `GetValue("${element}") called after Terminate`,
        element,
      );
    }
    return this.model.getValue(element);
  }

  setValue(element: string, value: string): void {
    if (this.phase === 'not_initialized') {
      throw new ScormApiError(
        this.is2004 ? E04.StoreDataBeforeInitialization : E12.NotInitialized,
        `SetValue("${element}") called before Initialize`,
        element,
      );
    }
    if (this.phase === 'terminated') {
      throw new ScormApiError(
        this.is2004 ? E04.StoreDataAfterTermination : E12.NotInitialized,
        `SetValue("${element}") called after Terminate`,
        element,
      );
    }
    this.model.setValue(element, value);
    this.dirty = true;
  }

  /**
   * ADL `Commit("")`. Returns the current CMI snapshot plus rollup so the
   * caller can persist it. Clears the dirty flag.
   */
  commit(): { state: CmiState; summary: CmiSummary } {
    if (this.phase === 'not_initialized') {
      throw new ScormApiError(
        this.is2004 ? E04.CommitBeforeInitialization : E12.NotInitialized,
        'Commit called before Initialize',
      );
    }
    if (this.phase === 'terminated') {
      throw new ScormApiError(
        this.is2004 ? E04.CommitAfterTermination : E12.NotInitialized,
        'Commit called after Terminate',
      );
    }
    this.dirty = false;
    return { state: this.model.export(), summary: this.model.summary() };
  }

  /**
   * ADL `Terminate("")` (SCORM 1.2 `LMSFinish`). Performs an implicit final
   * commit, then locks the session.
   */
  terminate(): { state: CmiState; summary: CmiSummary } {
    if (this.phase === 'not_initialized') {
      throw new ScormApiError(
        this.is2004 ? E04.TerminationBeforeInitialization : E12.NotInitialized,
        'Terminate called before Initialize',
      );
    }
    if (this.phase === 'terminated') {
      throw new ScormApiError(
        this.is2004 ? E04.TerminationAfterTermination : E12.NotInitialized,
        'Terminate called after Terminate',
      );
    }
    const snapshot = { state: this.model.export(), summary: this.model.summary() };
    this.phase = 'terminated';
    this.dirty = false;
    return snapshot;
  }

  hasUncommittedChanges(): boolean {
    return this.dirty;
  }

  snapshot(): { state: CmiState; summary: CmiSummary } {
    return { state: this.model.export(), summary: this.model.summary() };
  }
}

export function createDataModel(version: ScormVersion, context: RuntimeContext): DataModel {
  return version === 'SCORM_1_2'
    ? new Scorm12DataModel(context, version)
    : new Scorm2004DataModel(context, version);
}
