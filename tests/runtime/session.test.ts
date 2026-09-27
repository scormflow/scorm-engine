import { describe, expect, it } from 'vitest';

import { RuntimeSession } from '../../src/runtime/session.js';
import { Scorm12ErrorCode, Scorm2004ErrorCode, ScormApiError } from '../../src/runtime/errors.js';
import type { RuntimeContext } from '../../src/runtime/datamodel/types.js';

const ctx: RuntimeContext = { learnerId: 'l1', learnerName: 'Learner One' };

function codeOf(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof ScormApiError) return err.code;
    throw err;
  }
  throw new Error('expected a ScormApiError');
}

describe('RuntimeSession — lifecycle ordering (2004)', () => {
  it('rejects GetValue/SetValue/Commit before Initialize', () => {
    const s = new RuntimeSession({ version: 'SCORM_2004_4', context: ctx });
    expect(codeOf(() => s.getValue('cmi.location'))).toBe(
      Scorm2004ErrorCode.RetrieveDataBeforeInitialization,
    );
    expect(codeOf(() => s.setValue('cmi.location', 'x'))).toBe(
      Scorm2004ErrorCode.StoreDataBeforeInitialization,
    );
    expect(codeOf(() => s.commit())).toBe(Scorm2004ErrorCode.CommitBeforeInitialization);
  });

  it('rejects a second Initialize with 103', () => {
    const s = new RuntimeSession({ version: 'SCORM_2004_4', context: ctx });
    s.initialize();
    expect(codeOf(() => s.initialize())).toBe(Scorm2004ErrorCode.AlreadyInitialized);
  });

  it('rejects access after Terminate', () => {
    const s = new RuntimeSession({ version: 'SCORM_2004_4', context: ctx });
    s.initialize();
    s.terminate();
    expect(codeOf(() => s.getValue('cmi.location'))).toBe(
      Scorm2004ErrorCode.RetrieveDataAfterTermination,
    );
    expect(codeOf(() => s.terminate())).toBe(Scorm2004ErrorCode.TerminationAfterTermination);
  });
});

describe('RuntimeSession — lifecycle ordering (1.2)', () => {
  it('reports not-initialized (301) for premature access', () => {
    const s = new RuntimeSession({ version: 'SCORM_1_2', context: ctx });
    expect(codeOf(() => s.getValue('cmi.core.lesson_status'))).toBe(Scorm12ErrorCode.NotInitialized);
    expect(codeOf(() => s.setValue('cmi.core.lesson_status', 'completed'))).toBe(
      Scorm12ErrorCode.NotInitialized,
    );
  });
});

describe('RuntimeSession — commit + terminate snapshots', () => {
  it('tracks dirty state and returns a snapshot on commit', () => {
    const s = new RuntimeSession({ version: 'SCORM_1_2', context: ctx });
    s.initialize();
    expect(s.hasUncommittedChanges()).toBe(false);
    s.setValue('cmi.core.lesson_status', 'completed');
    expect(s.hasUncommittedChanges()).toBe(true);

    const { summary } = s.commit();
    expect(s.hasUncommittedChanges()).toBe(false);
    expect(summary.completionStatus).toBe('completed');
  });

  it('produces a final snapshot on terminate and locks the session', () => {
    const s = new RuntimeSession({ version: 'SCORM_2004_4', context: ctx });
    s.initialize();
    s.setValue('cmi.success_status', 'passed');
    s.setValue('cmi.score.scaled', '0.8');
    const { summary } = s.terminate();
    expect(summary.successStatus).toBe('passed');
    expect(summary.scoreScaled).toBe(0.8);
    expect(s.state).toBe('terminated');
  });
});

describe('RuntimeSession — resume', () => {
  it('rehydrates prior CMI state on construction', () => {
    const first = new RuntimeSession({ version: 'SCORM_2004_4', context: ctx });
    first.initialize();
    first.setValue('cmi.location', 'unit-2');
    first.setValue('cmi.suspend_data', 'blob');
    const { state } = first.terminate();

    const resumed = new RuntimeSession({
      version: 'SCORM_2004_4',
      context: { ...ctx, entry: 'resume' },
      resumeState: state,
    });
    resumed.initialize();
    expect(resumed.getValue('cmi.location')).toBe('unit-2');
    expect(resumed.getValue('cmi.suspend_data')).toBe('blob');
    expect(resumed.getValue('cmi.entry')).toBe('resume');
  });
});
