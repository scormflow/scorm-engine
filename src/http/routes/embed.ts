import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import type { PrismaClient } from '../../db/client.js';
import type { Env } from '../../config/env.js';
import { getRuntimeState, type RuntimeState } from '../../tracking/index.js';
import { ATTEMPT_COOKIE, type AttemptTokenPayload } from '../../auth/attempt-token.js';
import {
  renderBridgeConfig,
  renderPlayerPage,
  renderRuntimeBridge,
  type BridgeConfig,
  type BridgeReplayConfig,
} from '../runtime-bridge.js';

export interface EmbedRouteDeps {
  prisma: PrismaClient;
  env: Env;
}

interface TokenBody {
  attemptId?: string;
  ttlSeconds?: number;
}

type ContentSource = 'engine' | 'external';

interface ReplayQuery {
  /** `1` / `true` turns on session-replay capture for this launch. */
  replay?: string;
  /** `1` / `true` also records pointer positions (needs `replay`). */
  pointer?: string;
}

interface RuntimeQuery extends ReplayQuery {
  attemptId?: string;
  token?: string;
}

type Access =
  | { token: string; attemptId: string; payload: AttemptTokenPayload; state: RuntimeState }
  | { status: 400 | 401 | 403 | 404; error: { code: string; message: string } };

function denied(status: 400 | 401 | 403 | 404, code: string, message: string): Access {
  return { status, error: { code, message } };
}

const isTrue = (v: string | undefined) => v === '1' || v === 'true';

interface PlayQuery extends ReplayQuery {
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

    // Standalone runtime bridge. Without attemptId + token it is a static,
    // cacheable script configured by the host page's window.__SCORMFLOW__;
    // with them it is prefixed with that config, hydrated from the attempt, so a
    // single <script> tag is enough.
    app.get<{ Querystring: RuntimeQuery }>('/runtime.js', async (req, reply) => {
      const { attemptId, token } = req.query;
      if (attemptId === undefined && token === undefined) {
        reply.header('Cache-Control', RUNTIME_CACHE);
        reply.type('text/javascript; charset=utf-8');
        return renderRuntimeBridge();
      }
      const access = await authorize(token, attemptId);
      if ('error' in access) return reply.code(access.status).send(access.error);

      // Carries the token and live CMI state — never cache it.
      reply.header('Cache-Control', 'no-store');
      reply.type('text/javascript; charset=utf-8');
      const config: BridgeConfig = {
        apiBase: baseUrl(req),
        attemptId: access.attemptId,
        token: access.token,
        version: access.state.version,
        cmi: withLaunchContext(access.state),
        ...replayConfig(req.query),
      };
      return `${renderBridgeConfig(config)}\n${renderRuntimeBridge()}`;
    });

    // Self-contained player page. Token via query; content engine-hosted or external.
    app.get<{ Params: { attemptId: string }; Querystring: PlayQuery }>(
      '/play/:attemptId',
      async (req, reply) => {
        const access = await authorize(req.query.token, req.params.attemptId);
        if ('error' in access) return reply.code(access.status).send(access.error);
        const { payload, state, token } = access;

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
          cmi: withLaunchContext(state),
          contentUrl,
          theme: req.query.theme ?? 'auto',
          ...replayConfig(req.query),
        });
      },
    );

    /** Verify an attempt token against the attempt it is used for and load its runtime state. */
    async function authorize(token: string | undefined, attemptId: string | undefined): Promise<Access> {
      if (!token) return denied(401, 'unauthorized', 'Missing token');
      if (!attemptId) return denied(400, 'invalid_request', 'attemptId is required');
      let payload: AttemptTokenPayload;
      try {
        payload = app.verifyAttemptToken(token);
      } catch {
        return denied(401, 'unauthorized', 'Invalid or expired token');
      }
      if (payload.attemptId !== attemptId) {
        return denied(403, 'forbidden', 'Token is not valid for this attempt');
      }
      const state = await getRuntimeState(payload.tenantId, attemptId, prisma);
      if (!state) return denied(404, 'attempt_not_found', 'Attempt not found');
      return { token, attemptId, payload, state };
    }
  };

  /**
   * Session-replay capture is opt-in per launch (`?replay=1`) and only offered
   * when the engine accepts capture events at all.
   */
  function replayConfig(query: ReplayQuery): { replay?: BridgeReplayConfig } {
    if (!env.REPLAY_CAPTURE_ENABLED || !isTrue(query.replay)) return {};
    return { replay: isTrue(query.pointer) ? { pointer: true } : {} };
  }

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

/**
 * The bridge answers GetValue from the seeded CMI alone, so fold in the
 * read-only launch elements the engine owns — content checks `entry` to decide
 * whether to restore its location and suspend_data.
 */
function withLaunchContext(state: RuntimeState): Record<string, string> {
  const name = state.learner.name ?? state.learner.id;
  const launch =
    state.version === 'SCORM_1_2'
      ? {
          'cmi.core.entry': state.entry,
          'cmi.core.student_id': state.learner.id,
          'cmi.core.student_name': name,
        }
      : {
          'cmi.entry': state.entry,
          'cmi.learner_id': state.learner.id,
          'cmi.learner_name': name,
        };
  return { ...state.cmi, ...launch };
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
