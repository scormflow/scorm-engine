import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import type { PrismaClient } from '../../db/client.js';
import {
  applyCommit,
  AttemptServiceError,
  getRuntimeState,
  startOrResumeAttempt,
  syncCommits,
  type CertificateHook,
  type QueuedCommit,
  type ValidationMode,
} from '../../tracking/index.js';
import { serializeAttempt } from '../serialize-attempt.js';
import type { EventSink } from '../../webhooks/index.js';

export interface AttemptsRouteDeps {
  prisma: PrismaClient;
  /** Receives attempt lifecycle and progress events. */
  events?: EventSink | undefined;
  /** CMI write validation policy; defaults to 'lenient'. */
  validationMode?: ValidationMode;
  /** Issues completion certificates; certificates are off when omitted. */
  certificates?: CertificateHook | undefined;
}

interface StartBody {
  learnerId?: string;
  learnerName?: string;
  scoId?: string;
  mode?: string;
  restart?: boolean;
}

interface CommitBody {
  /** Element -> value writes to replay, as an object or ordered pairs. */
  values?: Record<string, string> | Array<[string, string]>;
  terminate?: boolean;
  /** Client commit sequence number; replays at or below the last applied seq are no-ops. */
  seq?: number;
  /** ISO 8601 time the client recorded the commit (offline queue). */
  recordedAt?: string;
}

interface SyncBody {
  commits?: CommitBody[];
}

/** Upper bound on commits accepted in one sync request. */
const MAX_SYNC_COMMITS = 500;

/**
 * Runtime API: start/resume an attempt and drive it with batched commits.
 *
 * The browser SDK keeps CMI in memory and flushes writes here; the server
 * replays them through an authoritative {@link import('../../runtime/index.js').RuntimeSession}
 * so validation and rollup never depend on the client.
 */
export function attemptsRoutes(deps: AttemptsRouteDeps): FastifyPluginAsync {
  const { prisma } = deps;
  const validationMode: ValidationMode = deps.validationMode ?? 'lenient';

  return async function (app: FastifyInstance): Promise<void> {
    app.post<{ Params: { courseId: string }; Body: StartBody }>(
      '/courses/:courseId/attempts',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const body = req.body ?? {};
        const learnerId = body.learnerId?.trim();
        if (!learnerId) {
          return reply.code(400).send({ code: 'invalid_request', message: 'learnerId is required' });
        }

        try {
          const started = await startOrResumeAttempt(
            {
              tenantId: req.tenantId,
              courseId: req.params.courseId,
              learnerExternalId: learnerId,
              learnerName: body.learnerName,
              scoId: body.scoId,
              mode: body.mode,
              restart: body.restart,
              events: deps.events,
            },
            prisma,
          );
          reply.code(started.resumed ? 200 : 201);
          return {
            attemptId: started.attemptId,
            resumed: started.resumed,
            version: started.version,
            entry: started.context.entry,
            launch: {
              learnerId: started.context.learnerId,
              learnerName: started.context.learnerName,
              mode: started.context.mode,
              totalTime: started.context.totalTime,
              masteryScore: started.context.masteryScore,
            },
            cmi: started.resumeState ?? {},
          };
        } catch (err) {
          return handleServiceError(err, reply);
        }
      },
    );

    app.post<{ Params: { id: string }; Body: CommitBody }>(
      '/attempts/:id/commit',
      // Browser players authenticate with an attempt token; servers use the API key.
      { preHandler: app.requireAttemptAccess },
      async (req, reply) => {
        const queued = parseQueuedCommit(req.body ?? {});
        if (typeof queued === 'string') {
          return reply.code(400).send({ code: 'invalid_request', message: queued });
        }
        try {
          const result = await applyCommit(
            {
              tenantId: req.tenantId,
              attemptId: req.params.id,
              values: queued.values,
              terminate: queued.terminate,
              mode: validationMode,
              events: deps.events,
              seq: queued.seq,
              recordedAt: queued.recordedAt,
              certificates: deps.certificates,
            },
            prisma,
          );
          return {
            ok: result.errors.length === 0,
            terminated: result.terminated,
            suspended: result.suspended,
            duplicate: result.duplicate,
            errors: result.errors,
            warnings: result.warnings,
            summary: result.summary,
          };
        } catch (err) {
          return handleServiceError(err, reply);
        }
      },
    );

    app.post<{ Params: { id: string }; Body: SyncBody }>(
      '/attempts/:id/sync',
      // Replays a client's offline commit queue; same auth as a live commit.
      { preHandler: app.requireAttemptAccess },
      async (req, reply) => {
        const raw = req.body?.commits;
        if (!Array.isArray(raw) || raw.length === 0) {
          return reply.code(400).send({ code: 'invalid_request', message: 'commits must be a non-empty array' });
        }
        if (raw.length > MAX_SYNC_COMMITS) {
          return reply
            .code(400)
            .send({ code: 'invalid_request', message: `at most ${MAX_SYNC_COMMITS} commits per sync` });
        }
        const commits: QueuedCommit[] = [];
        for (const [i, entry] of raw.entries()) {
          const queued = parseQueuedCommit(entry ?? {});
          if (typeof queued === 'string') {
            return reply.code(400).send({ code: 'invalid_request', message: `commits[${i}]: ${queued}` });
          }
          if (queued.seq === undefined) {
            return reply.code(400).send({ code: 'invalid_request', message: `commits[${i}]: seq is required` });
          }
          commits.push({ ...queued, seq: queued.seq });
        }
        try {
          return await syncCommits(
            {
              tenantId: req.tenantId,
              attemptId: req.params.id,
              commits,
              mode: validationMode,
              events: deps.events,
              certificates: deps.certificates,
            },
            prisma,
          );
        } catch (err) {
          return handleServiceError(err, reply);
        }
      },
    );

    app.get<{ Params: { id: string } }>(
      '/attempts/:id/runtime',
      { preHandler: app.requireAttemptAccess },
      async (req, reply) => {
        const state = await getRuntimeState(req.tenantId, req.params.id, prisma);
        if (!state) {
          return reply.code(404).send({ code: 'attempt_not_found', message: 'Attempt not found' });
        }
        return state;
      },
    );

    app.get<{ Params: { id: string } }>(
      '/attempts/:id',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const attempt = await prisma.attempt.findFirst({
          where: { id: req.params.id, tenantId: req.tenantId },
          include: {
            objectives: { orderBy: { index: 'asc' } },
            interactions: { orderBy: { index: 'asc' } },
          },
        });
        if (!attempt) {
          return reply.code(404).send({ code: 'attempt_not_found', message: 'Attempt not found' });
        }
        return serializeAttempt(attempt);
      },
    );
  };
}

/** Validate a commit body; returns an error message on bad input. */
function parseQueuedCommit(body: CommitBody): (Omit<QueuedCommit, 'seq'> & { seq?: number }) | string {
  if (body.seq !== undefined && (!Number.isSafeInteger(body.seq) || body.seq < 0)) {
    return 'seq must be a non-negative integer';
  }
  let recordedAt: Date | undefined;
  if (body.recordedAt !== undefined) {
    recordedAt = new Date(typeof body.recordedAt === 'string' ? body.recordedAt : NaN);
    if (Number.isNaN(recordedAt.getTime())) return 'recordedAt must be an ISO 8601 timestamp';
  }
  const parsed: Omit<QueuedCommit, 'seq'> & { seq?: number } = {
    values: normalizeValues(body.values),
    terminate: body.terminate,
    recordedAt,
  };
  if (body.seq !== undefined) parsed.seq = body.seq;
  return parsed;
}

function normalizeValues(
  values: CommitBody['values'],
): Array<[string, string]> {
  if (!values) return [];
  if (Array.isArray(values)) return values;
  return Object.entries(values);
}

function handleServiceError(err: unknown, reply: import('fastify').FastifyReply) {
  if (err instanceof AttemptServiceError) {
    return reply.code(err.status).send({ code: err.code, message: err.message });
  }
  throw err;
}

