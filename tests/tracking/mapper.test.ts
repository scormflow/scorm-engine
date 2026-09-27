import { describe, expect, it } from 'vitest';

import type { CmiSummary } from '../../src/runtime/datamodel/types.js';
import {
  extractInteractions,
  extractObjectives,
  lessonStatusFrom,
  rollupAttempt,
  sessionSeconds,
} from '../../src/tracking/mapper.js';

function summary(overrides: Partial<CmiSummary> = {}): CmiSummary {
  return {
    completionStatus: 'unknown',
    successStatus: 'unknown',
    scoreRaw: null,
    scoreMin: null,
    scoreMax: null,
    scoreScaled: null,
    progressMeasure: null,
    lessonLocation: null,
    suspendData: null,
    sessionTime: null,
    exit: null,
    ...overrides,
  };
}

describe('sessionSeconds', () => {
  it('parses a SCORM 1.2 HHHH:MM:SS timespan', () => {
    expect(sessionSeconds('0001:30:15', 'SCORM_1_2')).toBe(5415);
  });

  it('rounds SCORM 1.2 centiseconds to the nearest second', () => {
    expect(sessionSeconds('0000:00:01.50', 'SCORM_1_2')).toBe(2);
  });

  it('parses a SCORM 2004 ISO 8601 duration', () => {
    expect(sessionSeconds('PT1H30M15S', 'SCORM_2004_4')).toBe(5415);
  });

  it('returns 0 when session time is absent', () => {
    expect(sessionSeconds(null, 'SCORM_2004_4')).toBe(0);
  });
});

describe('lessonStatusFrom', () => {
  it('prefers the success axis when a learner passed', () => {
    expect(lessonStatusFrom(summary({ successStatus: 'passed', completionStatus: 'incomplete' }))).toBe(
      'PASSED',
    );
  });

  it('reports FAILED even when completion is complete', () => {
    expect(lessonStatusFrom(summary({ successStatus: 'failed', completionStatus: 'completed' }))).toBe(
      'FAILED',
    );
  });

  it('falls back to completion when success is unknown', () => {
    expect(lessonStatusFrom(summary({ successStatus: 'unknown', completionStatus: 'completed' }))).toBe(
      'COMPLETED',
    );
    expect(lessonStatusFrom(summary({ completionStatus: 'incomplete' }))).toBe('INCOMPLETE');
  });

  it('defaults to NOT_ATTEMPTED when nothing is known', () => {
    expect(lessonStatusFrom(summary())).toBe('NOT_ATTEMPTED');
  });
});

describe('rollupAttempt', () => {
  it('maps a passed 2004 attempt with a scaled score', () => {
    const rollup = rollupAttempt(
      summary({
        successStatus: 'passed',
        completionStatus: 'completed',
        scoreRaw: 88,
        scoreScaled: 0.88,
        progressMeasure: 1,
        sessionTime: 'PT10M',
      }),
      'SCORM_2004_4',
    );
    expect(rollup).toMatchObject({
      lessonStatus: 'PASSED',
      completionStatus: 'COMPLETED',
      successStatus: 'PASSED',
      scoreRaw: 88,
      scoreScaled: 0.88,
      progressMeasure: 1,
      sessionTimeSeconds: 600,
    });
  });
});

describe('extractObjectives', () => {
  it('reads SCORM 1.2 objectives and derives status', () => {
    const rows = extractObjectives(
      {
        'cmi.objectives.0.id': 'obj-intro',
        'cmi.objectives.0.status': 'passed',
        'cmi.objectives.0.score.raw': '90',
      },
      'SCORM_1_2',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      index: 0,
      identifier: 'obj-intro',
      scoreRaw: 90,
      successStatus: 'PASSED',
      completionStatus: 'COMPLETED',
    });
  });

  it('reads SCORM 2004 objectives with independent axes', () => {
    const rows = extractObjectives(
      {
        'cmi.objectives.0.id': 'obj-a',
        'cmi.objectives.0.success_status': 'failed',
        'cmi.objectives.0.completion_status': 'completed',
        'cmi.objectives.0.score.scaled': '0.4',
        'cmi.objectives.0.progress_measure': '1',
      },
      'SCORM_2004_4',
    );
    expect(rows[0]).toMatchObject({
      identifier: 'obj-a',
      successStatus: 'FAILED',
      completionStatus: 'COMPLETED',
      scoreScaled: 0.4,
      progressMeasure: 1,
    });
  });

  it('skips objectives that have no id', () => {
    const rows = extractObjectives({ 'cmi.objectives.0.score.raw': '10' }, 'SCORM_1_2');
    expect(rows).toHaveLength(0);
  });

  it('orders objectives by numeric index, not insertion order', () => {
    const rows = extractObjectives(
      {
        'cmi.objectives.2.id': 'c',
        'cmi.objectives.0.id': 'a',
        'cmi.objectives.10.id': 'k',
        'cmi.objectives.1.id': 'b',
      },
      'SCORM_1_2',
    );
    expect(rows.map((r) => r.identifier)).toEqual(['a', 'b', 'c', 'k']);
  });
});

describe('extractInteractions', () => {
  it('reads a SCORM 2004 interaction with learner_response and latency', () => {
    const rows = extractInteractions(
      {
        'cmi.interactions.0.id': 'q1',
        'cmi.interactions.0.type': 'choice',
        'cmi.interactions.0.learner_response': 'b',
        'cmi.interactions.0.correct_responses.0.pattern': 'b',
        'cmi.interactions.0.result': 'correct',
        'cmi.interactions.0.weighting': '1',
        'cmi.interactions.0.latency': 'PT45S',
      },
      'SCORM_2004_4',
    );
    expect(rows[0]).toMatchObject({
      identifier: 'q1',
      type: 'choice',
      learnerResponse: 'b',
      correctResponse: 'b',
      result: 'correct',
      weighting: 1,
      latencySeconds: 45,
    });
  });

  it('reads a SCORM 1.2 interaction using student_response', () => {
    const rows = extractInteractions(
      {
        'cmi.interactions.0.id': 'q1',
        'cmi.interactions.0.student_response': 'true',
        'cmi.interactions.0.latency': '0000:00:30',
      },
      'SCORM_1_2',
    );
    expect(rows[0]).toMatchObject({
      identifier: 'q1',
      learnerResponse: 'true',
      latencySeconds: 30,
    });
  });
});
