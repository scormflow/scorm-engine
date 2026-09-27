import { describe, expect, it } from 'vitest';

import { Scorm12DataModel } from '../../src/runtime/datamodel/scorm12.js';
import { Scorm12ErrorCode, ScormApiError } from '../../src/runtime/errors.js';
import type { RuntimeContext } from '../../src/runtime/datamodel/types.js';

const ctx: RuntimeContext = {
  learnerId: 'learner-1',
  learnerName: 'Ada Lovelace',
  masteryScore: 80,
  totalTime: '0001:00:00',
  launchData: 'ld',
};

function model(): Scorm12DataModel {
  return new Scorm12DataModel(ctx);
}

describe('Scorm12DataModel — read-only context', () => {
  it('serves learner identity and launch context', () => {
    const m = model();
    expect(m.getValue('cmi.core.student_id')).toBe('learner-1');
    expect(m.getValue('cmi.core.student_name')).toBe('Ada Lovelace');
    expect(m.getValue('cmi.core.total_time')).toBe('0001:00:00');
    expect(m.getValue('cmi.launch_data')).toBe('ld');
    expect(m.getValue('cmi.student_data.mastery_score')).toBe('80');
  });

  it('defaults credit/entry/mode when not supplied', () => {
    const m = new Scorm12DataModel({ learnerId: 'x', learnerName: 'y' });
    expect(m.getValue('cmi.core.credit')).toBe('credit');
    expect(m.getValue('cmi.core.entry')).toBe('ab-initio');
    expect(m.getValue('cmi.core.lesson_mode')).toBe('normal');
    expect(m.getValue('cmi.core.total_time')).toBe('0000:00:00');
  });

  it('rejects writes to read-only elements with error 403', () => {
    const m = model();
    expect(() => m.setValue('cmi.core.student_id', 'nope')).toThrowError(ScormApiError);
    try {
      m.setValue('cmi.core.total_time', '0000:00:01');
    } catch (err) {
      expect((err as ScormApiError).code).toBe(Scorm12ErrorCode.ElementReadOnly);
    }
  });
});

describe('Scorm12DataModel — keywords', () => {
  it('returns _children listings', () => {
    const m = model();
    expect(m.getValue('cmi.core._children')).toContain('lesson_status');
    expect(m.getValue('cmi.core.score._children')).toBe('raw,min,max');
  });

  it('reports collection counts that grow as members are written', () => {
    const m = model();
    expect(m.getValue('cmi.objectives._count')).toBe('0');
    m.setValue('cmi.objectives.0.id', 'obj-1');
    m.setValue('cmi.objectives.1.id', 'obj-2');
    expect(m.getValue('cmi.objectives._count')).toBe('2');
  });
});

describe('Scorm12DataModel — validation', () => {
  it('accepts vocabulary lesson_status values', () => {
    const m = model();
    for (const s of ['passed', 'completed', 'failed', 'incomplete', 'browsed', 'not attempted']) {
      expect(() => m.setValue('cmi.core.lesson_status', s)).not.toThrow();
    }
  });

  it('rejects an out-of-vocabulary lesson_status with 405', () => {
    const m = model();
    try {
      m.setValue('cmi.core.lesson_status', 'mastered');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ScormApiError).code).toBe(Scorm12ErrorCode.IncorrectDataType);
    }
  });

  it('bounds score.raw to 0..100 and allows blank', () => {
    const m = model();
    expect(() => m.setValue('cmi.core.score.raw', '87')).not.toThrow();
    expect(() => m.setValue('cmi.core.score.raw', '')).not.toThrow();
    expect(() => m.setValue('cmi.core.score.raw', '101')).toThrowError(ScormApiError);
    expect(() => m.setValue('cmi.core.score.raw', 'abc')).toThrowError(ScormApiError);
  });

  it('validates session_time as a CMITimespan', () => {
    const m = model();
    expect(() => m.setValue('cmi.core.session_time', '00:05:30')).not.toThrow();
    expect(() => m.setValue('cmi.core.session_time', '5 minutes')).toThrowError(ScormApiError);
  });

  it('caps suspend_data at 4096 characters', () => {
    const m = model();
    expect(() => m.setValue('cmi.suspend_data', 'a'.repeat(4096))).not.toThrow();
    expect(() => m.setValue('cmi.suspend_data', 'a'.repeat(4097))).toThrowError(ScormApiError);
  });
});

describe('Scorm12DataModel — write-only + round-trip', () => {
  it('treats exit/session_time as write-only on read', () => {
    const m = model();
    m.setValue('cmi.core.exit', 'suspend');
    try {
      m.getValue('cmi.core.exit');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ScormApiError).code).toBe(Scorm12ErrorCode.ElementWriteOnly);
    }
  });

  it('round-trips learner writes through export/import', () => {
    const m = model();
    m.setValue('cmi.core.lesson_status', 'completed');
    m.setValue('cmi.core.lesson_location', 'page-5');
    m.setValue('cmi.suspend_data', 'state-blob');
    const dumped = m.export();

    const resumed = new Scorm12DataModel(ctx);
    resumed.import(dumped);
    expect(resumed.getValue('cmi.core.lesson_status')).toBe('completed');
    expect(resumed.getValue('cmi.core.lesson_location')).toBe('page-5');
    expect(resumed.getValue('cmi.suspend_data')).toBe('state-blob');
  });
});

describe('Scorm12DataModel — summary rollup', () => {
  it('maps passed → completed + passed with score', () => {
    const m = model();
    m.setValue('cmi.core.lesson_status', 'passed');
    m.setValue('cmi.core.score.raw', '92');
    m.setValue('cmi.core.session_time', '00:10:00');
    const s = m.summary();
    expect(s.completionStatus).toBe('completed');
    expect(s.successStatus).toBe('passed');
    expect(s.scoreRaw).toBe(92);
    expect(s.sessionTime).toBe('00:10:00');
  });

  it('maps incomplete → incomplete + unknown', () => {
    const m = model();
    m.setValue('cmi.core.lesson_status', 'incomplete');
    const s = m.summary();
    expect(s.completionStatus).toBe('incomplete');
    expect(s.successStatus).toBe('unknown');
  });
});
