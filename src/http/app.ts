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

export interface AppDeps {
  env: Env;
  prisma?: PrismaClient;
  storage?: StorageAdapter;
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

  await app.register(apiKeyAuth, { prisma });
  await app.register(attemptAuth);

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => ({ status: 'ready' }));

  await app.register(
    async (api) => {
      await api.register(registerRoutes);
      await api.register(coursesRoutes({ prisma, storage }), { prefix: '/courses' });
      await api.register(contentRoutes({ prisma, storage }));
      await api.register(attemptsRoutes({ prisma, validationMode: env.SCORM_VALIDATION_MODE }));
      await api.register(analyticsRoutes({ prisma }), { prefix: '/analytics' });
      await api.register(embedRoutes({ prisma, env }));
    },
    { prefix: '/api/v1' },
  );

  return app;
}
