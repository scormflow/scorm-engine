import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Per-tenant request rate limiting.
 *
 * Every tenant gets a fixed window of `max` requests per `windowSeconds`,
 * shared by all of its credentials (API keys, attempt tokens, cmi5 sessions),
 * so one noisy tenant cannot starve the others. Counters live in process
 * memory: each engine instance enforces its own budget.
 *
 * The check runs after a route's auth preHandler has resolved `req.tenantId`,
 * so unauthenticated routes (health checks, the runtime bridge, content files
 * that authenticate inside their handler) are never counted.
 */

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms at which the current window ends and the budget refills. */
  resetAt: number;
  /** Whole seconds until `resetAt`. */
  resetSeconds: number;
}

export interface TenantRateLimiterOptions {
  /** Requests allowed per window. 0 disables limiting. */
  max: number;
  windowSeconds: number;
  /** Per-tenant override of `max` (e.g. from a plan). Return undefined to use the default, 0 to exempt. */
  limitFor?: (tenantId: string) => number | undefined;
  now?: () => number;
}

interface Window {
  start: number;
  count: number;
}

export class TenantRateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #limitFor: TenantRateLimiterOptions['limitFor'];
  readonly #now: () => number;
  readonly #windows = new Map<string, Window>();
  #lastSweep = 0;

  constructor(opts: TenantRateLimiterOptions) {
    this.#max = opts.max;
    this.#windowMs = opts.windowSeconds * 1000;
    this.#limitFor = opts.limitFor;
    this.#now = opts.now ?? Date.now;
  }

  /** Whether any tenant can be limited at all. */
  get enabled(): boolean {
    return this.#max > 0 || this.#limitFor !== undefined;
  }

  /** Count one request for `tenantId`. Returns null when the tenant is not limited. */
  consume(tenantId: string): RateLimitDecision | null {
    const limit = this.#limitFor?.(tenantId) ?? this.#max;
    if (limit <= 0) return null;

    const now = this.#now();
    this.#sweep(now);
    let win = this.#windows.get(tenantId);
    if (!win || now - win.start >= this.#windowMs) {
      win = { start: now, count: 0 };
      this.#windows.set(tenantId, win);
    }
    const resetAt = win.start + this.#windowMs;
    const resetSeconds = Math.max(0, Math.ceil((resetAt - now) / 1000));
    if (win.count >= limit) {
      return { allowed: false, limit, remaining: 0, resetAt, resetSeconds };
    }
    win.count += 1;
    return { allowed: true, limit, remaining: limit - win.count, resetAt, resetSeconds };
  }

  /** Drop expired windows at most once per window so the map stays bounded by active tenants. */
  #sweep(now: number): void {
    if (now - this.#lastSweep < this.#windowMs) return;
    this.#lastSweep = now;
    for (const [tenantId, win] of this.#windows) {
      if (now - win.start >= this.#windowMs) this.#windows.delete(tenantId);
    }
  }
}

export interface TenantRateLimitPluginOptions {
  limiter: TenantRateLimiter;
}

const tenantRateLimitPlugin: FastifyPluginAsync<TenantRateLimitPluginOptions> = async (app, opts) => {
  const { limiter } = opts;
  if (!limiter.enabled) {
    app.decorate('tenantRateLimit', null);
    return;
  }

  const enforce: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.tenantId) return;
    const decision = limiter.consume(req.tenantId);
    if (!decision) return;

    const { resetSeconds } = decision;
    reply.header('x-ratelimit-limit', decision.limit);
    reply.header('x-ratelimit-remaining', decision.remaining);
    reply.header('x-ratelimit-reset', resetSeconds);
    if (!decision.allowed) {
      reply.header('retry-after', Math.max(1, resetSeconds));
      return reply.code(429).send({
        code: 'rate_limited',
        message: `Rate limit of ${decision.limit} requests per window exceeded; retry in ${Math.max(1, resetSeconds)}s`,
      });
    }
  };

  app.decorate('tenantRateLimit', enforce);

  // Append the check after each route's own preHandlers, which is where the
  // auth guards resolve the tenant.
  app.addHook('onRoute', (route) => {
    const existing = route.preHandler;
    if (!existing) return;
    route.preHandler = [...(Array.isArray(existing) ? existing : [existing]), enforce];
  });
};

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The per-tenant limit check, for routes that gain their auth guard after
     * registration (plugin routes); `null` when limiting is off.
     */
    tenantRateLimit: preHandlerHookHandler | null;
  }
}

export const tenantRateLimit = fp(tenantRateLimitPlugin, {
  name: 'tenant-rate-limit',
  dependencies: ['api-key-auth'],
});
