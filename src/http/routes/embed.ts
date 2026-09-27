import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import type { PrismaClient } from '../../db/client.js';
import type { Env } from '../../config/env.js';
import { getRuntimeState } from '../../tracking/index.js';
import { ATTEMPT_COOKIE } from '../../auth/attempt-token.js';
import { renderPlayerPage, renderRuntimeBridge } from '../runtime-bridge.js';

export interface EmbedRouteDeps {
  prisma: PrismaClient;
  env: Env;
}

interface TokenBody {
  attemptId?: string;
  ttlSeconds?: number;
}

type ContentSource = 'engine' | 'external';

interface PlayQuery {
  token?: string;
  theme?: 'light' | 'dark' | 'auto';
  scoId?: string;
  /** 'engine' (default) serves the uploaded package; 'external' uses `src`. */
  source?: ContentSource;
  /** Required when source=external: absolute URL to the SCO entry. */
  src?: string;
}

const RUNTIME_CACHE = 'public, max-age=3600';

/**
 * SDK-less embed flow: mint an attempt token, serve the runtime bridge script,
 * and serve a self-contained player page.
 */
export function embedRoutes(deps: EmbedRouteDeps): FastifyPluginAsync {
  const { prisma, env } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    // Mint a short-lived attempt token (API-key protected).
    app.post<{ Body: TokenBody }>(
      '/auth/attempt-token',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const attemptId = req.body?.attemptId?.trim();
        if (!attemptId) {
          return reply.code(400).send({ code: 'invalid_request', message: 'attemptId is required' });
        }
        const attempt = await prisma.attempt.findFirst({
          where: { id: attemptId, tenantId: req.tenantId },
          select: { id: true },
        });
        if (!attempt) {
          return reply.code(404).send({ code: 'attempt_not_found', message: 'Attempt not found' });
        }
        const ttl = clampTtl(req.body?.ttlSeconds, env.JWT_ATTEMPT_TTL_SECONDS);
        return app.signAttemptToken(attemptId, req.tenantId, ttl);
      },
    );

    // Standalone runtime bridge (no auth; harmless static script).
    app.get('/runtime.js', async (_req, reply) => {
      reply.header('Cache-Control', RUNTIME_CACHE);
      reply.type('text/javascript; charset=utf-8');
      return renderRuntimeBridge();
    });

    // Self-contained player page. Token via query; content engine-hosted or external.
    app.get<{ Params: { attemptId: string }; Querystring: PlayQuery }>(
      '/play/:attemptId',
      async (req, reply) => {
        const token = req.query.token;
        if (!token) {
          return reply.code(401).send({ code: 'unauthorized', message: 'Missing token' });
        }
        let payload;
        try {
          payload = app.verifyAttemptToken(token);
        } catch {
          return reply.code(401).send({ code: 'unauthorized', message: 'Invalid or expired token' });
        }
        if (payload.attemptId !== req.params.attemptId) {
          return reply.code(403).send({ code: 'forbidden', message: 'Token is not valid for this attempt' });
        }

        const state = await getRuntimeState(payload.tenantId, req.params.attemptId, prisma);
        if (!state) {
          return reply.code(404).send({ code: 'attempt_not_found', message: 'Attempt not found' });
        }

        const source: ContentSource = req.query.source === 'external' ? 'external' : 'engine';
        const contentUrl = await resolveContentUrl(source, req.query, payload, prisma);
        if (!contentUrl) {
          return reply.code(400).send({
            code: 'no_content',
            message:
              source === 'external'
                ? 'source=external requires a "src" URL'
                : 'Could not resolve engine-hosted content for this course',
          });
        }

        const apiBase = baseUrl(req);
        // Cookie lets the SCO's relative sub-resource requests authenticate.
        if (source === 'engine') {
          reply.header(
            'Set-Cookie',
            `${ATTEMPT_COOKIE}=${encodeURIComponent(token)}; Path=/api/v1/courses; HttpOnly; SameSite=Lax`,
          );
        }
        reply.type('text/html; charset=utf-8');
        return renderPlayerPage({
          apiBase,
          attemptId: req.params.attemptId,
          token,
          version: state.version,
          cmi: state.cmi,
          contentUrl,
          theme: req.query.theme ?? 'auto',
        });
      },
    );
  };

  async function resolveContentUrl(
    source: ContentSource,
    query: PlayQuery,
    payload: { attemptId: string; tenantId: string; scoId?: string },
    prisma: PrismaClient,
  ): Promise<string | null> {
    if (source === 'external') {
      return query.src && /^https?:\/\//.test(query.src) ? query.src : null;
    }
    // Engine-hosted: resolve the SCO's launch href within the course content path.
    const attempt = await prisma.attempt.findFirst({
      where: { id: payload.attemptId, tenantId: payload.tenantId },
      select: { courseId: true, scoId: true, course: { select: { launchUrl: true, storageKey: true } } },
    });
    if (!attempt) return null;

    const scoId = query.scoId ?? payload.scoId ?? attempt.scoId ?? undefined;
    let launchHref: string | undefined;
    if (scoId) {
      const sco = await prisma.sco.findFirst({
        where: { courseId: attempt.courseId, identifier: scoId },
        select: { launchHref: true },
      });
      launchHref = sco?.launchHref;
    }
    // Fall back to the course's primary launch URL (storageKey-relative).
    if (!launchHref) {
      const prefix = `${attempt.course.storageKey}/`;
      launchHref = attempt.course.launchUrl.startsWith(prefix)
        ? attempt.course.launchUrl.slice(prefix.length)
        : attempt.course.launchUrl;
    }
    return `/api/v1/courses/${encodeURIComponent(attempt.courseId)}/content/${launchHref}`;
  }
}

function clampTtl(requested: number | undefined, fallback: number): number {
  if (requested == null || !Number.isFinite(requested)) return fallback;
  return Math.max(60, Math.min(86_400, Math.floor(requested)));
}

function baseUrl(req: { protocol: string; headers: Record<string, unknown> }): string {
  const host = req.headers['host'];
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  return `${proto}://${host}/api/v1`;
}
