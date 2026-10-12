import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import jwt from '@fastify/jwt';

import type { Env } from '../config/env.js';
import { prisma as defaultPrisma, type PrismaClient } from '../db/index.js';
import { createStorage } from '../storage/index.js';
import type { StorageAdapter } from '../storage/types.js';
import { apiKeyAuth } from '../auth/api-key.js';
import { attemptAuth } from '../auth/attempt-token.js';
import { registerRoutes } from './routes/index.js';
import { coursesRoutes } from './routes/courses.js';
import { attemptsRoutes } from './routes/attempts.js';
import { analyticsRoutes } from './routes/analytics.js';
import { contentRoutes } from './routes/content.js';
import { embedRoutes } from './routes/embed.js';
import { xapiRoutes } from './routes/xapi.js';
import { cmi5Routes } from './routes/cmi5.js';
import { webhookRoutes } from './routes/webhooks.js';
import { certificateRoutes } from './routes/certificates.js';
import { CertificateIssuer } from '../certificates/index.js';
import { WebhookDispatcher } from '../webhooks/index.js';
import { TenantRateLimiter, tenantRateLimit } from './rate-limit.js';
import { registerHealthRoutes } from './health.js';
import { ENGINE_VERSION } from '../version.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Publishes engine events to the tenant's webhook endpoints. */
    webhooks: WebhookDispatcher;
  }
}

export interface AppDeps {
  env: Env;
  prisma?: PrismaClient;
  storage?: StorageAdapter;
  /** Supply a dispatcher (e.g. one with a stubbed `fetch`); one is built from `env` otherwise. */
  webhooks?: WebhookDispatcher;
  /**
   * Poll for due webhook retries every `WEBHOOK_WORKER_INTERVAL_MS`. The server
   * entrypoint turns this on; embedders and tests opt in.
   */
  startWebhookWorker?: boolean;
  /** Supply a limiter (e.g. with per-tenant `limitFor` overrides); one is built from `RATE_LIMIT_*` otherwise. */
  rateLimiter?: TenantRateLimiter;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const env = deps.env;
  const prisma = deps.prisma ?? defaultPrisma;
  const storage = deps.storage ?? createStorage(env);

  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? {
            level: env.LOG_LEVEL,
            transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
          }
        : { level: env.LOG_LEVEL },
    // 200 MB celing
    bodyLimit: 200 * 1024 * 1024,
  });

  await app.register(sensible);
  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, {
    limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  });
  await app.register(jwt, { secret: env.JWT_SECRET });

  const webhooks =
    deps.webhooks ??
    new WebhookDispatcher({
      prisma,
      maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
      retryBaseSeconds: env.WEBHOOK_RETRY_BASE_SECONDS,
      timeoutMs: env.WEBHOOK_TIMEOUT_MS,
      logger: app.log,
    });
  app.decorate('webhooks', webhooks);
  if (deps.startWebhookWorker) webhooks.start(env.WEBHOOK_WORKER_INTERVAL_MS);
  app.addHook('onClose', async () => webhooks.stop());

  await app.register(apiKeyAuth, { prisma });
  await app.register(attemptAuth);
  await app.register(tenantRateLimit, {
    limiter:
      deps.rateLimiter ??
      new TenantRateLimiter({ max: env.RATE_LIMIT_MAX, windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS }),
  });

  const certificates = env.CERTIFICATES_ENABLED
    ? new CertificateIssuer(
        prisma,
        {
          issuer: env.CERTIFICATE_ISSUER,
          verifyBaseUrl: env.CERTIFICATE_VERIFY_BASE_URL,
          accentColor: env.CERTIFICATE_ACCENT_COLOR,
        },
        webhooks,
        app.log,
      )
    : undefined;

  const health = { prisma, storage, version: ENGINE_VERSION };
  registerHealthRoutes(app, health, { health: '/healthz', ready: '/readyz' });

  await app.register(
    async (api) => {
      registerHealthRoutes(api, health, { health: '/health', ready: '/ready' });
      await api.register(registerRoutes);
      await api.register(coursesRoutes({ prisma, storage }), { prefix: '/courses' });
      await api.register(contentRoutes({ prisma, storage }));
      await api.register(
        attemptsRoutes({ prisma, validationMode: env.SCORM_VALIDATION_MODE, events: webhooks, certificates }),
      );
      if (certificates) await api.register(certificateRoutes({ certificates }));
      await api.register(analyticsRoutes({ prisma }), { prefix: '/analytics' });
      await api.register(embedRoutes({ prisma, env }));
      await api.register(xapiRoutes({ prisma, storage, env, events: webhooks }), { prefix: '/xapi' });
      await api.register(cmi5Routes({ prisma, storage, env, events: webhooks }), { prefix: '/cmi5' });
      await api.register(webhookRoutes({ prisma, env, dispatcher: webhooks }), { prefix: '/webhooks' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
