import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import type { PrismaClient } from '../../db/client.js';
import {
  applyCommit,
  AttemptServiceError,
  getRuntimeState,
  startOrResumeAttempt,
  type ValidationMode,
} from '../../tracking/index.js';
import { serializeAttempt } from '../serialize-attempt.js';

export interface AttemptsRouteDeps {
  prisma: PrismaClient;
  /** CMI write validation policy; defaults to 'lenient'. */
  validationMode?: ValidationMode;
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
}

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
        const body = req.body ?? {};
        try {
          const result = await applyCommit(
            {
              tenantId: req.tenantId,
              attemptId: req.params.id,
              values: normalizeValues(body.values),
              terminate: body.terminate,
              mode: validationMode,
            },
            prisma,
          );
          return {
            ok: result.errors.length === 0,
            terminated: result.terminated,
            errors: result.errors,
            warnings: result.warnings,
            summary: result.summary,
          };
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

