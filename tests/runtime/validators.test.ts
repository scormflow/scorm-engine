import { describe, expect, it } from 'vitest';

import {
  addScorm12Timespans,
  addScorm2004Durations,
  isIso8601DateTime,
  isScorm12Timespan,
  isScorm2004Duration,
  iso8601ToSeconds,
  scorm12ToCentis,
  secondsToIso8601,
} from '../../src/runtime/datamodel/validators.js';

describe('timespan validation', () => {
  it('accepts SCORM 1.2 timespans', () => {
    expect(isScorm12Timespan('00:00:00')).toBe(true);
    expect(isScorm12Timespan('9999:59:59.99')).toBe(true);
    expect(isScorm12Timespan('1:00:00')).toBe(false);
    expect(isScorm12Timespan('PT1H')).toBe(false);
  });

  it('accepts ISO 8601 durations', () => {
    expect(isScorm2004Duration('PT1H30M')).toBe(true);
    expect(isScorm2004Duration('P1DT2H3M4S')).toBe(true);
    expect(isScorm2004Duration('PT0S')).toBe(true);
    expect(isScorm2004Duration('P')).toBe(false);
    expect(isScorm2004Duration('01:30:00')).toBe(false);
  });

  it('validates ISO 8601 datetimes', () => {
    expect(isIso8601DateTime('2026-09-27T21:30:00')).toBe(true);
    expect(isIso8601DateTime('2026-09-27T21:30:00Z')).toBe(true);
    expect(isIso8601DateTime('2026-09-27 21:30')).toBe(false);
  });
});

describe('timespan arithmetic', () => {
  it('accumulates SCORM 1.2 session time into total time', () => {
    expect(scorm12ToCentis('00:01:00')).toBe(6000);
    expect(addScorm12Timespans('00:10:00', '00:05:30')).toBe('00:15:30');
    expect(addScorm12Timespans('00:00:00.50', '00:00:00.75')).toBe('00:00:01.25');
  });

  it('accumulates ISO 8601 durations', () => {
    expect(iso8601ToSeconds('PT1H')).toBe(3600);
    expect(addScorm2004Durations('PT1H', 'PT30M')).toBe('PT1H30M');
    expect(addScorm2004Durations('PT0S', 'PT0S')).toBe('PT0S');
  });

  it('round-trips seconds through ISO 8601', () => {
    expect(secondsToIso8601(3661)).toBe('PT1H1M1S');
    expect(secondsToIso8601(90000)).toBe('P1DT1H');
    expect(iso8601ToSeconds(secondsToIso8601(12345))).toBe(12345);
  });
});
