import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Short-lived, attempt-scoped JWTs for the SDK-less embed flow.
 *
 * The LMS backend mints one of these (with its API key) via
 * `POST /auth/attempt-token`; the browser player then authenticates runtime
 * calls with it instead of the long-lived API key. A token grants access to
 * exactly one attempt.
 */

export const ATTEMPT_TOKEN_KIND = 'attempt';

export interface AttemptTokenPayload {
  kind: typeof ATTEMPT_TOKEN_KIND;
  attemptId: string;
  tenantId: string;
  /** Optional SCO override carried through to the player. */
  scoId?: string;
}

/** Name of the cookie the /play page sets so content sub-resource requests authenticate. */
export const ATTEMPT_COOKIE = 'sf_attempt';

const attemptTokenPlugin: FastifyPluginAsync = async (app) => {
  // Mint an attempt token. Assumes the caller already verified the attempt
  // belongs to the tenant.
  app.decorate(
    'signAttemptToken',
    (attemptId: string, tenantId: string, ttlSeconds: number, scoId?: string) => {
      const payload: AttemptTokenPayload = {
        kind: ATTEMPT_TOKEN_KIND,
        attemptId,
        tenantId,
        ...(scoId ? { scoId } : {}),
      };
      const token = app.jwt.sign(payload, { expiresIn: ttlSeconds });
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      return { token, expiresAt };
    },
  );

  // Verify + decode an attempt token, or throw 401.
  app.decorate('verifyAttemptToken', (token: string): AttemptTokenPayload => {
    let decoded: unknown;
    try {
      decoded = app.jwt.verify(token);
    } catch {
      throw app.httpErrors.unauthorized('Invalid or expired attempt token');
    }
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      (decoded as AttemptTokenPayload).kind !== ATTEMPT_TOKEN_KIND
    ) {
      throw app.httpErrors.unauthorized('Not an attempt token');
    }
    return decoded as AttemptTokenPayload;
  });

  /**
   * Route guard accepting EITHER a tenant API key (full access) OR an attempt
   * token scoped to the attempt targeted by the request. The target attempt id
   * is read from `params.id`, `params.attemptId`, or `query.attemptId`.
   */
  app.decorate('requireAttemptAccess', async (req: FastifyRequest) => {
    if (req.headers['x-api-key']) {
      await app.requireApiKey(req);
      return;
    }
    const token = extractToken(req);
    if (!token) {
      throw app.httpErrors.unauthorized('Missing attempt token or API key');
    }
    const payload = app.verifyAttemptToken(token);
    const target = targetAttemptId(req);
    if (target && payload.attemptId !== target) {
      throw app.httpErrors.forbidden('Token is not valid for this attempt');
    }
    req.tenantId = payload.tenantId;
  });
};

export const attemptAuth = fp(attemptTokenPlugin, {
  name: 'attempt-auth',
  dependencies: ['api-key-auth'],
});

/** Read a bearer token from the Authorization header, `?token=`, or the attempt cookie. */
export function extractToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const q = (req.query as Record<string, unknown> | undefined)?.['token'];
  if (typeof q === 'string' && q) return q;
  return readCookie(req.headers.cookie, ATTEMPT_COOKIE);
}

function targetAttemptId(req: FastifyRequest): string | undefined {
  const params = req.params as Record<string, string> | undefined;
  const query = req.query as Record<string, unknown> | undefined;
  return (
    params?.['id'] ??
    params?.['attemptId'] ??
    (typeof query?.['attemptId'] === 'string' ? (query['attemptId'] as string) : undefined)
  );
}

/** Minimal cookie parser (avoids an extra dependency). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    signAttemptToken: (
      attemptId: string,
      tenantId: string,
      ttlSeconds: number,
      scoId?: string,
    ) => { token: string; expiresAt: string };
    verifyAttemptToken: (token: string) => AttemptTokenPayload;
    requireAttemptAccess: (req: FastifyRequest) => Promise<void>;
  }
}
