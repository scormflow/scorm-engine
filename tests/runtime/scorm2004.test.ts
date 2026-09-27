import { describe, expect, it } from 'vitest';

import { Scorm2004DataModel } from '../../src/runtime/datamodel/scorm2004.js';
import { Scorm2004ErrorCode, ScormApiError } from '../../src/runtime/errors.js';
import type { RuntimeContext } from '../../src/runtime/datamodel/types.js';

const ctx: RuntimeContext = {
  learnerId: 'L-42',
  learnerName: 'Grace Hopper',
  totalTime: 'PT1H',
  scaledPassingScore: 0.7,
};

function model(): Scorm2004DataModel {
  return new Scorm2004DataModel(ctx, 'SCORM_2004_4');
}

describe('Scorm2004DataModel — context + version', () => {
  it('exposes learner identity and _version', () => {
    const m = model();
    expect(m.getValue('cmi._version')).toBe('1.0');
    expect(m.getValue('cmi.learner_id')).toBe('L-42');
    expect(m.getValue('cmi.learner_name')).toBe('Grace Hopper');
    expect(m.getValue('cmi.total_time')).toBe('PT1H');
    expect(m.getValue('cmi.scaled_passing_score')).toBe('0.7');
  });

  it('errors 403 on reading an uninitialized element', () => {
    const m = model();
    try {
      m.getValue('cmi.location');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ScormApiError).code).toBe(Scorm2004ErrorCode.ValueNotInitialized);
    }
  });

  it('errors 401 on an undefined element', () => {
    const m = model();
    try {
      m.getValue('cmi.nonsense.element');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ScormApiError).code).toBe(Scorm2004ErrorCode.UndefinedDataModelElement);
    }
  });
});

describe('Scorm2004DataModel — completion/success split', () => {
  it('tracks completion_status and success_status independently', () => {
    const m = model();
    m.setValue('cmi.completion_status', 'completed');
    m.setValue('cmi.success_status', 'passed');
    expect(m.getValue('cmi.completion_status')).toBe('completed');
    expect(m.getValue('cmi.success_status')).toBe('passed');
  });

  it('rejects invalid vocabulary with 406', () => {
    const m = model();
    try {
      m.setValue('cmi.completion_status', 'done');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ScormApiError).code).toBe(Scorm2004ErrorCode.TypeMismatch);
    }
  });
});

describe('Scorm2004DataModel — ranges', () => {
  it('accepts score.scaled in [-1,1] and rejects out of range with 407', () => {
    const m = model();
    expect(() => m.setValue('cmi.score.scaled', '0.85')).not.toThrow();
    expect(() => m.setValue('cmi.score.scaled', '-1')).not.toThrow();
    try {
      m.setValue('cmi.score.scaled', '1.5');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ScormApiError).code).toBe(Scorm2004ErrorCode.ValueOutOfRange);
    }
  });

  it('bounds progress_measure to [0,1]', () => {
    const m = model();
    expect(() => m.setValue('cmi.progress_measure', '0.4')).not.toThrow();
    try {
      m.setValue('cmi.progress_measure', '2');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ScormApiError).code).toBe(Scorm2004ErrorCode.ValueOutOfRange);
    }
  });

  it('validates session_time as an ISO 8601 duration', () => {
    const m = model();
    expect(() => m.setValue('cmi.session_time', 'PT1H30M')).not.toThrow();
    expect(() => m.setValue('cmi.session_time', '01:30:00')).toThrowError(ScormApiError);
  });
});

describe('Scorm2004DataModel — interactions', () => {
  it('stores an interaction with nested collections and counts', () => {
    const m = model();
    m.setValue('cmi.interactions.0.id', 'q1');
    m.setValue('cmi.interactions.0.type', 'choice');
    m.setValue('cmi.interactions.0.timestamp', '2026-09-27T21:30:00');
    m.setValue('cmi.interactions.0.learner_response', 'a[,]c');
    m.setValue('cmi.interactions.0.result', 'correct');
    m.setValue('cmi.interactions.0.objectives.0.id', 'obj-1');
    m.setValue('cmi.interactions.0.correct_responses.0.pattern', 'a[,]b');

    expect(m.getValue('cmi.interactions._count')).toBe('1');
    expect(m.getValue('cmi.interactions.0.objectives._count')).toBe('1');
    expect(m.getValue('cmi.interactions.0.correct_responses._count')).toBe('1');
    expect(m.getValue('cmi.interactions.0.type')).toBe('choice');
  });

  it('rejects an unknown interaction type with 406', () => {
    const m = model();
    try {
      m.setValue('cmi.interactions.0.type', 'essay');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ScormApiError).code).toBe(Scorm2004ErrorCode.TypeMismatch);
    }
  });
});

describe('Scorm2004DataModel — summary', () => {
  it('rolls up scaled score, progress, and statuses', () => {
    const m = model();
    m.setValue('cmi.completion_status', 'completed');
    m.setValue('cmi.success_status', 'passed');
    m.setValue('cmi.score.scaled', '0.9');
    m.setValue('cmi.progress_measure', '1');
    m.setValue('cmi.location', 'chapter-3');
    const s = m.summary();
    expect(s.completionStatus).toBe('completed');
    expect(s.successStatus).toBe('passed');
    expect(s.scoreScaled).toBe(0.9);
    expect(s.progressMeasure).toBe(1);
    expect(s.lessonLocation).toBe('chapter-3');
  });
});
