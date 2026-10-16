import type { Prisma } from '@prisma/client';

import type { PrismaClient } from '../db/client.js';
import type { CmiState } from '../runtime/datamodel/types.js';
import { SPEC_VERSION } from '../tracking/attempts.js';
import { buildCourseHeatmap, type CourseHeatmap } from './heatmap.js';
import { buildTimeline, type AttemptTimeline, type ReplayClientEventInput } from './timeline.js';

/**
 * Session replay service: stores the player's opt-in capture events and
 * rebuilds attempt timelines and course heatmaps on read. Nothing is
 * precomputed — a timeline is derived from the commit log (always there) plus
 * whatever capture events the player sent.
 */

export class ReplayError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

export interface ReplaySettings {
  /** Accept client capture events at all (timelines from commits work regardless). */
  captureEnabled: boolean;
  /** Stored capture events per attempt; later ones are dropped. */
  maxEventsPerAttempt: number;
}

/** Upper bound on events accepted in one request. */
export const MAX_EVENTS_PER_BATCH = 500;
/** Commits read when rebuilding one timeline. */
export const MAX_TIMELINE_COMMITS = 1000;
/** Upper bound on capture events read for one timeline. */
const MAX_TIMELINE_EVENTS = 10_000;
/** Largest serialized `data` object accepted on one event. */
const MAX_EVENT_DATA_BYTES = 2048;
/** Allowed clock skew between the player and the engine. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const EVENT_TYPE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export interface ReplayEventInput {
  /** Client-generated id; a retried event with the same id is stored once. */
  id?: string;
  type: string;
  /** ISO 8601 time the event happened. */
  at: string;
  location?: string | null;
  data?: Record<string, unknown>;
}

export interface RecordEventsResult {
  accepted: number;
  duplicates: number;
  /** Events over the per-attempt cap, not stored. */
  dropped: number;
}

export interface AttemptReplay extends AttemptTimeline {
  attemptId: string;
  courseId: string;
  learner: { id: string; name: string | null };
  status: string;
  completionStatus: string;
  successStatus: string;
  /** True when the attempt had more commits or events than one timeline reads. */
  truncated: boolean;
}

export interface CourseHeatmapResult extends CourseHeatmap {
  courseId: string;
  /** True when more attempts matched than `limit`; the most recent ones were used. */
  truncated: boolean;
}

export interface HeatmapQuery {
  /** Most recent attempts to include (default 50, at most 200). */
  limit?: number | undefined;
  /** Only attempts started at or after this time. */
  since?: Date | undefined;
}

const ATTEMPT_SELECT = {
  id: true,
  courseId: true,
  status: true,
  lessonStatus: true,
  completionStatus: true,
  successStatus: true,
  progressMeasure: true,
  startedAt: true,
  finishedAt: true,
  lastCommitAt: true,
  learner: { select: { externalId: true, name: true } },
  course: { select: { scormVersion: true } },
} as const;

type AttemptRow = NonNullable<
  Awaited<ReturnType<PrismaClient['attempt']['findFirst']>>
> & {
  learner: { externalId: string; name: string | null };
  course: { scormVersion: string };
};

export class ReplayService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: ReplaySettings,
  ) {}

  /** Store a batch of capture events for an attempt, skipping ones already stored. */
  async recordEvents(tenantId: string, attemptId: string, input: unknown): Promise<RecordEventsResult> {
    if (!this.settings.captureEnabled) {
      throw new ReplayError(403, 'replay_capture_disabled', 'Session replay capture is turned off on this engine');
    }
    const attempt = await this.prisma.attempt.findFirst({
      where: { id: attemptId, tenantId },
      select: { id: true, startedAt: true },
    });
    if (!attempt) throw new ReplayError(404, 'attempt_not_found', 'Attempt not found');

    const events = parseReplayEvents(input, attempt.startedAt, new Date());

    // Drop repeats within the batch and ones a retried request already stored.
    const seen = new Set<string>();
    const fresh = events.filter((e) => {
      if (e.clientId === null) return true;
      if (seen.has(e.clientId)) return false;
      seen.add(e.clientId);
      return true;
    });
    const ids = [...seen];
    const stored =
      ids.length === 0
        ? new Set<string>()
        : new Set(
            (
              await this.prisma.replayEvent.findMany({
                where: { attemptId, clientId: { in: ids } },
                select: { clientId: true },
              })
            ).map((r) => r.clientId),
          );
    const toStore = fresh.filter((e) => e.clientId === null || !stored.has(e.clientId));
    const duplicates = events.length - toStore.length;

    const existing = await this.prisma.replayEvent.count({ where: { attemptId } });
    const room = Math.max(0, this.settings.maxEventsPerAttempt - existing);
    const kept = toStore.slice(0, room);
    if (kept.length > 0) {
      await this.prisma.replayEvent.createMany({
        data: kept.map((e) => ({
          tenantId,
          attemptId,
          clientId: e.clientId,
          type: e.type,
          location: e.location,
          data: e.data as Prisma.InputJsonValue,
          at: e.at,
        })),
        // A concurrent retry of the same batch may have stored some meanwhile.
        skipDuplicates: true,
      });
    }
    return { accepted: kept.length, duplicates, dropped: toStore.length - kept.length };
  }

  /** Rebuild one attempt's replay timeline and engagement score. */
  async attemptReplay(tenantId: string, attemptId: string): Promise<AttemptReplay> {
    const attempt = (await this.prisma.attempt.findFirst({
      where: { id: attemptId, tenantId },
      select: ATTEMPT_SELECT,
    })) as AttemptRow | null;
    if (!attempt) throw new ReplayError(404, 'attempt_not_found', 'Attempt not found');

    const { timeline, truncated } = await this.timelineFor(attempt);
    return {
      attemptId: attempt.id,
      courseId: attempt.courseId,
      learner: { id: attempt.learner.externalId, name: attempt.learner.name ?? null },
      status: attempt.status,
      completionStatus: attempt.completionStatus,
      successStatus: attempt.successStatus,
      truncated,
      ...timeline,
    };
  }

  /** Per-location dwell, interaction, drop-off and pointer figures across a course's recent attempts. */
  async courseHeatmap(tenantId: string, courseId: string, query: HeatmapQuery = {}): Promise<CourseHeatmapResult> {
    const course = await this.prisma.course.findFirst({ where: { id: courseId, tenantId }, select: { id: true } });
    if (!course) throw new ReplayError(404, 'course_not_found', 'Course not found');

    const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)));
    const attempts = (await this.prisma.attempt.findMany({
      where: { tenantId, courseId, ...(query.since ? { startedAt: { gte: query.since } } : {}) },
      orderBy: { startedAt: 'desc' },
      take: limit + 1,
      select: ATTEMPT_SELECT,
    })) as AttemptRow[];
    const used = attempts.slice(0, limit);

    // One attempt at a time keeps only one attempt's commit states in memory.
    const timelines = [];
    for (const attempt of used) {
      const { timeline } = await this.timelineFor(attempt);
      timelines.push({ timeline, completed: isFinished(attempt) });
    }
    return { courseId, truncated: attempts.length > limit, ...buildCourseHeatmap(timelines) };
  }

  private async timelineFor(attempt: AttemptRow): Promise<{ timeline: AttemptTimeline; truncated: boolean }> {
    const [commits, events] = await Promise.all([
      this.prisma.commitLog.findMany({
        where: { attemptId: attempt.id },
        orderBy: { createdAt: 'asc' },
        take: MAX_TIMELINE_COMMITS + 1,
        select: { values: true, recordedAt: true, createdAt: true },
      }),
      this.prisma.replayEvent.findMany({
        where: { attemptId: attempt.id },
        orderBy: { at: 'asc' },
        take: MAX_TIMELINE_EVENTS + 1,
        select: { type: true, location: true, data: true, at: true },
      }),
    ]);

    const timeline = buildTimeline(
      {
        version: SPEC_VERSION[attempt.course.scormVersion] ?? 'SCORM_1_2',
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        lastCommitAt: attempt.lastCommitAt,
        status: attempt.status,
        completionStatus: attempt.completionStatus,
        successStatus: attempt.successStatus,
        lessonStatus: attempt.lessonStatus,
        progressMeasure: attempt.progressMeasure,
      },
      commits.slice(0, MAX_TIMELINE_COMMITS).map((c) => ({
        values: (c.values ?? {}) as CmiState,
        at: c.recordedAt ?? c.createdAt,
      })),
      events.slice(0, MAX_TIMELINE_EVENTS).map(
        (e): ReplayClientEventInput => ({
          type: e.type,
          location: e.location ?? null,
          data: (e.data ?? {}) as Record<string, unknown>,
          at: e.at,
        }),
      ),
    );
    return {
      timeline,
      truncated: commits.length > MAX_TIMELINE_COMMITS || events.length > MAX_TIMELINE_EVENTS,
    };
  }
}

function isFinished(attempt: AttemptRow): boolean {
  return attempt.completionStatus === 'COMPLETED' || ['PASSED', 'COMPLETED', 'FAILED'].includes(attempt.lessonStatus);
}

export interface ParsedReplayEvent {
  clientId: string | null;
  type: string;
  location: string | null;
  data: Record<string, unknown>;
  at: Date;
}

/**
 * Validate a capture batch. The whole batch is rejected on the first bad event
 * so a buggy recorder is noticed rather than silently losing half its events.
 */
export function parseReplayEvents(input: unknown, startedAt: Date, now: Date): ParsedReplayEvent[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ReplayError(400, 'invalid_request', 'events must be a non-empty array');
  }
  if (input.length > MAX_EVENTS_PER_BATCH) {
    throw new ReplayError(400, 'invalid_request', `at most ${MAX_EVENTS_PER_BATCH} events per request`);
  }
  const earliest = startedAt.getTime() - CLOCK_SKEW_MS;
  const latest = now.getTime() + CLOCK_SKEW_MS;

  return input.map((raw, i): ParsedReplayEvent => {
    const fail = (message: string): never => {
      throw new ReplayError(400, 'invalid_request', `events[${i}]: ${message}`);
    };
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('must be an object');
    const e = raw as Record<string, unknown>;

    if (typeof e['type'] !== 'string' || e['type'].length > 64 || !EVENT_TYPE.test(e['type'])) {
      fail('type must be a dotted lowercase name such as "page.hidden" or "quiz.skipped"');
    }
    const at = new Date(typeof e['at'] === 'string' ? e['at'] : NaN);
    if (Number.isNaN(at.getTime())) fail('at must be an ISO 8601 timestamp');
    if (at.getTime() < earliest || at.getTime() > latest) fail('at is outside the attempt');

    const id = e['id'];
    if (id !== undefined && (typeof id !== 'string' || !CLIENT_ID.test(id))) {
      fail('id must be 1-64 characters of letters, digits, ".", "_", ":" or "-"');
    }
    const location = e['location'];
    if (location !== undefined && location !== null && (typeof location !== 'string' || location.length > 255)) {
      fail('location must be a string of at most 255 characters');
    }
    const data = e['data'] ?? {};
    if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('data must be an object');
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_EVENT_DATA_BYTES) {
      fail(`data must serialize to at most ${MAX_EVENT_DATA_BYTES} bytes`);
    }
    const payload = data as Record<string, unknown>;
    if (e['type'] === 'pointer' && !(isUnit(payload['x']) && isUnit(payload['y']))) {
      fail('pointer events need data.x and data.y between 0 and 1');
    }

    return {
      clientId: (id as string | undefined) ?? null,
      type: e['type'] as string,
      location: typeof location === 'string' && location !== '' ? location : null,
      data: payload,
      at,
    };
  });
}

const isUnit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
