import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { ReplayError, type ReplayService } from '../../replay/index.js';

export interface ReplayRouteDeps {
  replay: ReplayService;
}

/**
 * Session replay.
 *
 *  - `POST /attempts/:id/replay/events` — the player's opt-in capture batches,
 *    authenticated like a commit (attempt token or API key);
 *  - `GET /attempts/:id/replay` — the rebuilt timeline and engagement score;
 *  - `GET /courses/:courseId/heatmap` — per-location figures across attempts.
 */
export function replayRoutes(deps: ReplayRouteDeps): FastifyPluginAsync {
  const { replay } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ReplayError) {
        return reply.code(err.status).send({ code: err.code, message: err.message });
      }
      return reply.send(err);
    });

    app.post<{ Params: { id: string }; Body: { events?: unknown } }>(
      '/attempts/:id/replay/events',
      { preHandler: app.requireAttemptAccess },
      async (req) => replay.recordEvents(req.tenantId, req.params.id, req.body?.events),
    );

    app.get<{ Params: { id: string } }>(
      '/attempts/:id/replay',
      { preHandler: app.requireApiKey },
      async (req) => replay.attemptReplay(req.tenantId, req.params.id),
    );

    app.get<{ Params: { courseId: string }; Querystring: { limit?: string; since?: string } }>(
      '/courses/:courseId/heatmap',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const { limit, since } = req.query;
        const parsedLimit = limit === undefined ? undefined : Number(limit);
        if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
          return reply.code(400).send({ code: 'invalid_request', message: 'limit must be a positive integer' });
        }
        const sinceDate = since === undefined ? undefined : new Date(since);
        if (sinceDate && Number.isNaN(sinceDate.getTime())) {
          return reply.code(400).send({ code: 'invalid_request', message: 'since must be an ISO 8601 timestamp' });
        }
        return replay.courseHeatmap(req.tenantId, req.params.courseId, { limit: parsedLimit, since: sinceDate });
      },
    );
  };
}
