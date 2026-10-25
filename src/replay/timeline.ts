/**
 * Session replay: rebuild what a learner did during an attempt as an ordered
 * timeline — launched, moved to slide 3, answered q1 wrong, tab hidden for two
 * minutes, suspended, resumed, passed.
 *
 * Two sources feed it. Every commit's full CMI state is already kept in the
 * commit log, so diffing consecutive commits recovers what the *content*
 * reported (location, status, score, interactions, objectives, suspend). The
 * player can additionally send opt-in *client* events for what happens between
 * commits (tab hidden, idle, navigation, media, pointer position, or any
 * content-defined event).
 *
 * Everything here is pure: rows in, timeline out.
 */
import type { ScormVersion } from '../parser/manifest.js';
import type { CmiState } from '../runtime/datamodel/types.js';
import { extractInteractions, extractObjectives } from '../tracking/mapper.js';

/** Who reported an entry: the engine itself, the SCO via a commit, or the player's capture. */
export type ReplaySource = 'engine' | 'content' | 'client';

export interface TimelineEntry {
  at: string;
  /** Seconds since the attempt started. */
  offsetSeconds: number;
  type: string;
  source: ReplaySource;
  /** Course location (slide / page) the learner was on at the time, if known. */
  location: string | null;
  data: Record<string, unknown>;
}

export interface LocationVisit {
  location: string;
  enteredAt: string;
  leftAt: string;
  /** Seconds on the location, not counting suspended, hidden, idle or long-silent stretches. */
  activeSeconds: number;
}

export type EngagementLevel = 'high' | 'medium' | 'low';

export interface EngagementScore {
  /** 0–100. */
  score: number;
  level: EngagementLevel;
  /**
   * Each 0–1. `focus` needs client capture and `interactivity` needs at least
   * one interaction or pointer event; a null component is left out and the
   * others are reweighted.
   */
  components: { progress: number; focus: number | null; interactivity: number | null };
  activeSeconds: number;
  hiddenSeconds: number;
  idleSeconds: number;
  focusLosses: number;
  interactions: number;
  locationsVisited: number;
}

export interface AttemptTimeline {
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  /** Commits the timeline was rebuilt from. */
  commits: number;
  /** Whether the player sent any client capture events. */
  captured: boolean;
  entries: TimelineEntry[];
  visits: LocationVisit[];
  engagement: EngagementScore;
}

export interface ReplayAttemptInput {
  version: ScormVersion;
  startedAt: Date;
  finishedAt: Date | null;
  lastCommitAt: Date | null;
  status: string;
  completionStatus: string;
  successStatus: string;
  lessonStatus: string;
  progressMeasure: number | null;
}

export interface ReplayCommitInput {
  /** The full CMI state after the commit, as the commit log stores it. */
  values: CmiState;
  /** When the commit happened (the client's `recordedAt` for offline commits). */
  at: Date;
}

export interface ReplayClientEventInput {
  type: string;
  location: string | null;
  data: Record<string, unknown>;
  at: Date;
}

/**
 * Client event types the timeline understands. Any other dotted lowercase name
 * (`quiz.skipped`, `video.watched`) is a content-defined event and is shown as is.
 */
export const CLIENT_EVENT_TYPES = [
  'page.hidden',
  'page.visible',
  'idle.start',
  'idle.end',
  'navigation',
  'pointer',
  'media.play',
  'media.pause',
  'media.ended',
] as const;

/** A silence longer than this between any two entries counts as time away. */
export const SILENCE_GAP_SECONDS = 30 * 60;

const WEIGHTS = { progress: 0.4, focus: 0.3, interactivity: 0.3 } as const;

interface CmiKeys {
  location: string;
  statuses: string[];
  scoreRaw: string;
  scoreScaled: string | null;
  scoreMin: string;
  scoreMax: string;
  progress: string | null;
  exit: string;
}

function cmiKeys(version: ScormVersion): CmiKeys {
  return version === 'SCORM_1_2'
    ? {
        location: 'cmi.core.lesson_location',
        statuses: ['cmi.core.lesson_status'],
        scoreRaw: 'cmi.core.score.raw',
        scoreScaled: null,
        scoreMin: 'cmi.core.score.min',
        scoreMax: 'cmi.core.score.max',
        progress: null,
        exit: 'cmi.core.exit',
      }
    : {
        location: 'cmi.location',
        statuses: ['cmi.completion_status', 'cmi.success_status'],
        scoreRaw: 'cmi.score.raw',
        scoreScaled: 'cmi.score.scaled',
        scoreMin: 'cmi.score.min',
        scoreMax: 'cmi.score.max',
        progress: 'cmi.progress_measure',
        exit: 'cmi.exit',
      };
}

type RawEntry = Omit<TimelineEntry, 'at' | 'offsetSeconds'> & { at: Date };

/** Rebuild an attempt's replay timeline, location visits and engagement score. */
export function buildTimeline(
  attempt: ReplayAttemptInput,
  commits: readonly ReplayCommitInput[],
  clientEvents: readonly ReplayClientEventInput[],
): AttemptTimeline {
  const raw: RawEntry[] = [
    { at: attempt.startedAt, type: 'attempt.started', source: 'engine', location: null, data: {} },
    ...commitEntries(attempt.version, sortByTime(commits)),
    ...sortByTime(clientEvents).map((e): RawEntry => ({
      at: e.at,
      type: e.type,
      source: 'client',
      location: e.location,
      data: e.data,
    })),
  ];
  if (attempt.finishedAt) {
    raw.push({
      at: attempt.finishedAt,
      type: 'attempt.finished',
      source: 'engine',
      location: null,
      data: {
        status: attempt.status,
        completionStatus: attempt.completionStatus,
        successStatus: attempt.successStatus,
      },
    });
  }
  // Stable sort keeps commit-derived entries in the order they were diffed.
  raw.sort((a, b) => a.at.getTime() - b.at.getTime());

  // Entries without a location inherit the one the learner was on.
  let current: string | null = null;
  for (const entry of raw) {
    const moved = movedTo(entry);
    if (moved !== null) current = moved;
    else if (entry.location === null) entry.location = current;
    else current = entry.location;
  }

  const start = attempt.startedAt.getTime();
  const lastSeen = Math.max(start, attempt.lastCommitAt?.getTime() ?? start, ...raw.map((e) => e.at.getTime()));
  // A player's unload flush can land just after Terminate; keep it on the timeline.
  const end = Math.max(attempt.finishedAt?.getTime() ?? lastSeen, lastSeen);

  const away = inactiveIntervals(raw, end);
  const visits = locationVisits(raw, end, away.all);
  const entries = raw.map(
    (e): TimelineEntry => ({
      at: e.at.toISOString(),
      offsetSeconds: round1((e.at.getTime() - start) / 1000),
      type: e.type,
      source: e.source,
      location: e.location,
      data: e.data,
    }),
  );

  return {
    startedAt: attempt.startedAt.toISOString(),
    endedAt: new Date(end).toISOString(),
    durationSeconds: round1((end - start) / 1000),
    commits: commits.length,
    captured: clientEvents.length > 0,
    entries,
    visits,
    engagement: scoreEngagement(attempt, raw, visits, away, start, end, clientEvents.length > 0),
  };
}

/** The location an entry moves the learner to, or null if it does not navigate. */
function movedTo(entry: RawEntry): string | null {
  if (entry.type === 'location.changed' && typeof entry.data['to'] === 'string') return entry.data['to'];
  if (entry.type === 'navigation' && entry.location) return entry.location;
  return null;
}

/** Diff consecutive commit states into the changes the content reported. */
function commitEntries(version: ScormVersion, commits: readonly ReplayCommitInput[]): RawEntry[] {
  const keys = cmiKeys(version);
  const out: RawEntry[] = [];
  let prev: CmiState = {};
  for (const commit of commits) {
    const cur = commit.values ?? {};
    const at = commit.at;
    const location = nonEmpty(cur[keys.location]);
    const push = (type: string, data: Record<string, unknown>) =>
      out.push({ at, type, source: 'content', location, data });

    if (prev[keys.exit] === 'suspend') push('session.resumed', {});

    if (location !== null && location !== nonEmpty(prev[keys.location])) {
      // Emitted with the location being left, so it stays on the old visit.
      out.push({
        at,
        type: 'location.changed',
        source: 'content',
        location: nonEmpty(prev[keys.location]),
        data: { from: nonEmpty(prev[keys.location]), to: location },
      });
    }

    for (const element of keys.statuses) {
      const to = nonEmpty(cur[element]);
      if (to !== null && to !== nonEmpty(prev[element])) {
        push('status.changed', { element, from: nonEmpty(prev[element]), to });
      }
    }

    const scoreKeys = [keys.scoreRaw, keys.scoreScaled].filter((k): k is string => k !== null);
    if (scoreKeys.some((k) => nonEmpty(cur[k]) !== null && cur[k] !== prev[k])) {
      push('score.changed', {
        raw: num(cur[keys.scoreRaw]),
        scaled: keys.scoreScaled ? num(cur[keys.scoreScaled]) : null,
        min: num(cur[keys.scoreMin]),
        max: num(cur[keys.scoreMax]),
      });
    }

    if (keys.progress && nonEmpty(cur[keys.progress]) !== null && cur[keys.progress] !== prev[keys.progress]) {
      push('progress.changed', { from: num(prev[keys.progress]), to: num(cur[keys.progress]) });
    }

    const before = new Map(extractInteractions(prev, version).map((i) => [i.index, i]));
    for (const row of extractInteractions(cur, version)) {
      const old = before.get(row.index);
      if (old && old.result === row.result && old.learnerResponse === row.learnerResponse) continue;
      push('interaction.recorded', {
        index: row.index,
        id: row.identifier,
        type: row.type,
        result: row.result,
        learnerResponse: row.learnerResponse,
        correctResponse: row.correctResponse,
        latencySeconds: row.latencySeconds,
      });
    }

    const objectivesBefore = new Map(extractObjectives(prev, version).map((o) => [o.identifier, o]));
    for (const row of extractObjectives(cur, version)) {
      const old = objectivesBefore.get(row.identifier);
      if (old && old.successStatus === row.successStatus && old.completionStatus === row.completionStatus) continue;
      if (!old && row.successStatus === null && row.completionStatus === null) continue;
      push('objective.updated', {
        id: row.identifier,
        successStatus: row.successStatus,
        completionStatus: row.completionStatus,
        scoreScaled: row.scoreScaled,
      });
    }

    if (cur[keys.exit] === 'suspend' && prev[keys.exit] !== 'suspend') push('session.suspended', {});
    prev = cur;
  }
  return out;
}

interface Interval {
  from: number;
  to: number;
}

interface AwayIntervals {
  hidden: Interval[];
  idle: Interval[];
  /** Union of every reason the learner was away, merged and sorted. */
  all: Interval[];
}

/** Stretches the learner was not engaged: suspended, tab hidden, idle, or silent too long. */
function inactiveIntervals(entries: readonly RawEntry[], end: number): AwayIntervals {
  const paired = (startType: string, endType: string): Interval[] => {
    const out: Interval[] = [];
    let open: number | null = null;
    for (const e of entries) {
      if (e.type === startType && open === null) open = e.at.getTime();
      else if (e.type === endType && open !== null) {
        out.push({ from: open, to: e.at.getTime() });
        open = null;
      }
    }
    if (open !== null && open < end) out.push({ from: open, to: end });
    return out;
  };

  const hidden = paired('page.hidden', 'page.visible');
  const idle = paired('idle.start', 'idle.end');
  const suspended = paired('session.suspended', 'session.resumed');
  const gaps: Interval[] = [];
  const times = [...entries.map((e) => e.at.getTime()), end].sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    if (times[i]! - times[i - 1]! > SILENCE_GAP_SECONDS * 1000) gaps.push({ from: times[i - 1]!, to: times[i]! });
  }
  return { hidden, idle, all: mergeIntervals([...hidden, ...idle, ...suspended, ...gaps]) };
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.to > i.from).sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.from <= last.to) last.to = Math.max(last.to, i.to);
    else out.push({ ...i });
  }
  return out;
}

/** Milliseconds of `intervals` that fall inside [from, to]. */
function overlap(intervals: readonly Interval[], from: number, to: number): number {
  let total = 0;
  for (const i of intervals) total += Math.max(0, Math.min(i.to, to) - Math.max(i.from, from));
  return total;
}

function activeSeconds(away: readonly Interval[], from: number, to: number): number {
  return round1(Math.max(0, to - from - overlap(away, from, to)) / 1000);
}

function locationVisits(entries: readonly RawEntry[], end: number, away: readonly Interval[]): LocationVisit[] {
  const stops: Array<{ at: number; location: string }> = [];
  for (const e of entries) {
    const to = movedTo(e);
    if (to === null) continue;
    if (stops[stops.length - 1]?.location === to) continue;
    stops.push({ at: e.at.getTime(), location: to });
  }
  return stops.map((stop, i) => {
    const leftAt = Math.max(stop.at, stops[i + 1]?.at ?? end);
    return {
      location: stop.location,
      enteredAt: new Date(stop.at).toISOString(),
      leftAt: new Date(leftAt).toISOString(),
      activeSeconds: activeSeconds(away, stop.at, leftAt),
    };
  });
}

function scoreEngagement(
  attempt: ReplayAttemptInput,
  entries: readonly RawEntry[],
  visits: readonly LocationVisit[],
  away: AwayIntervals,
  start: number,
  end: number,
  captured: boolean,
): EngagementScore {
  const active = activeSeconds(away.all, start, end);
  const hiddenSeconds = round1(overlap(mergeIntervals(away.hidden), start, end) / 1000);
  const idleSeconds = round1(overlap(mergeIntervals(away.idle), start, end) / 1000);
  const interactions = new Set(
    entries.filter((e) => e.type === 'interaction.recorded').map((e) => String(e.data['index'])),
  ).size;
  const pointers = entries.filter((e) => e.type === 'pointer').length;

  const progress = progressOf(attempt);
  // Of the time the learner had the course open, how much they spent looking at it.
  const present = active + hiddenSeconds + idleSeconds;
  const focus = captured ? (present > 0 ? clamp01(active / present) : 1) : null;
  // One answered interaction per two active minutes counts as fully interactive;
  // pointer events count a fifth of an interaction each.
  const interactivity =
    interactions + pointers > 0 ? clamp01((interactions + pointers / 5) / Math.max(1, active / 120)) : null;

  const parts: Array<[number, number]> = [[progress, WEIGHTS.progress]];
  if (focus !== null) parts.push([focus, WEIGHTS.focus]);
  if (interactivity !== null) parts.push([interactivity, WEIGHTS.interactivity]);
  const weight = parts.reduce((s, [, w]) => s + w, 0);
  const score = Math.round((100 * parts.reduce((s, [v, w]) => s + v * w, 0)) / weight);

  return {
    score,
    level: score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low',
    components: { progress: round2(progress), focus: focus === null ? null : round2(focus), interactivity: interactivity === null ? null : round2(interactivity) },
    activeSeconds: active,
    hiddenSeconds,
    idleSeconds,
    focusLosses: entries.filter((e) => e.type === 'page.hidden').length,
    interactions,
    locationsVisited: new Set(visits.map((v) => v.location)).size,
  };
}

function progressOf(attempt: ReplayAttemptInput): number {
  if (attempt.completionStatus === 'COMPLETED') return 1;
  if (attempt.version === 'SCORM_1_2') {
    // 1.2's lesson_status conflates the axes: passed / failed also mean finished.
    if (['PASSED', 'COMPLETED', 'FAILED'].includes(attempt.lessonStatus)) return 1;
    if (attempt.lessonStatus === 'INCOMPLETE') return 0.5;
    if (attempt.lessonStatus === 'BROWSED') return 0.25;
    return 0;
  }
  if (attempt.progressMeasure !== null) return clamp01(attempt.progressMeasure);
  return attempt.completionStatus === 'INCOMPLETE' ? 0.5 : 0;
}

function sortByTime<T extends { at: Date }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
}

function nonEmpty(v: string | undefined): string | null {
  return v === undefined || v === '' ? null : v;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
