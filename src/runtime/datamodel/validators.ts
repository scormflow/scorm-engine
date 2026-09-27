/**
 * CMI value validators shared by the SCORM 1.2 and 2004 data models.
 *
 * Each validator returns `true` when the raw string is a legal representation
 * of the type. The data models call these before accepting a `SetValue`, and
 * raise the edition-appropriate type-mismatch / out-of-range error otherwise.
 */

/** SCORM 1.2 CMITimespan: HHHH:MM:SS(.ss) with 2–4 hour digits. */
const SCORM12_TIMESPAN = /^\d{2,4}:\d{2}:\d{2}(\.\d{1,2})?$/;

/** SCORM 2004 timeinterval: ISO 8601 duration, e.g. PT1H30M5S / P1DT2H. */
const SCORM2004_DURATION =
  /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d{1,2})?S)?)?$/;

/** ISO 8601 datetime, optionally with timezone. Used by 2004 interaction timestamps. */
const ISO_8601_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

export function isCmiDecimal(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}

/** A decimal constrained to an inclusive numeric range. */
export function isDecimalInRange(value: string, min: number, max: number): boolean {
  if (!isCmiDecimal(value)) return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

export function isInteger(value: string): boolean {
  return /^-?\d+$/.test(value);
}

export function isNonNegativeInteger(value: string): boolean {
  return /^\d+$/.test(value);
}

/** A string no longer than `max` UTF-16 code units. SCORM length caps are code-unit based. */
export function isBoundedString(value: string, max: number): boolean {
  return value.length <= max;
}

export function isScorm12Timespan(value: string): boolean {
  return SCORM12_TIMESPAN.test(value);
}

export function isScorm2004Duration(value: string): boolean {
  return SCORM2004_DURATION.test(value) && value !== 'P' && value !== 'PT';
}

export function isIso8601DateTime(value: string): boolean {
  return ISO_8601_DATETIME.test(value);
}

/** Membership test for a fixed controlled vocabulary. */
export function isInVocabulary(value: string, vocab: readonly string[]): boolean {
  return vocab.includes(value);
}

/**
 * Add two SCORM 1.2 timespans (HHHH:MM:SS.ss). Used to fold a committed
 * session_time into an attempt's accumulated total_time.
 */
export function addScorm12Timespans(a: string, b: string): string {
  return centisToScorm12(scorm12ToCentis(a) + scorm12ToCentis(b));
}

/** Add two ISO 8601 durations, returning an ISO 8601 duration (seconds precision). */
export function addScorm2004Durations(a: string, b: string): string {
  return secondsToIso8601(iso8601ToSeconds(a) + iso8601ToSeconds(b));
}

export function scorm12ToCentis(value: string): number {
  const m = SCORM12_TIMESPAN.exec(value);
  if (!m) return 0;
  const [h, min, rest] = value.split(':') as [string, string, string];
  const [sec, frac = ''] = rest.split('.');
  const centis = frac ? Number(frac.padEnd(2, '0').slice(0, 2)) : 0;
  return ((Number(h) * 3600 + Number(min) * 60 + Number(sec)) * 100) + centis;
}

function centisToScorm12(totalCentis: number): string {
  const centis = totalCentis % 100;
  const totalSeconds = Math.floor(totalCentis / 100);
  const h = Math.floor(totalSeconds / 3600);
  const min = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${pad(h)}:${pad(min)}:${pad(sec)}`;
  return centis > 0 ? `${base}.${pad(centis)}` : base;
}

export function iso8601ToSeconds(value: string): number {
  const m =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (!m) return 0;
  const [, y, mo, w, d, h, min, s] = m;
  // Calendar-agnostic approximation: year≈365d, month≈30d. Adequate for
  // accumulating elapsed learner time, which never spans those units in practice.
  return (
    Number(y ?? 0) * 365 * 86400 +
    Number(mo ?? 0) * 30 * 86400 +
    Number(w ?? 0) * 7 * 86400 +
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(min ?? 0) * 60 +
    Number(s ?? 0)
  );
}

export function secondsToIso8601(totalSeconds: number): string {
  const whole = Math.floor(totalSeconds);
  const days = Math.floor(whole / 86400);
  const hours = Math.floor((whole % 86400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  let out = 'P';
  if (days > 0) out += `${days}D`;
  if (hours > 0 || minutes > 0 || seconds > 0) {
    out += 'T';
    if (hours > 0) out += `${hours}H`;
    if (minutes > 0) out += `${minutes}M`;
    if (seconds > 0) out += `${seconds}S`;
  }
  return out === 'P' ? 'PT0S' : out;
}
