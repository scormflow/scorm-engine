import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import type { PrismaClient } from '../../db/client.js';
import { type StorageAdapter, StorageNotFoundError } from '../../storage/types.js';
import { extractToken } from '../../auth/attempt-token.js';

export interface ContentRouteDeps {
  prisma: PrismaClient;
  storage: StorageAdapter;
}

/**
 * Streams extracted SCORM package files for engine-hosted content
 * (`GET /courses/:courseId/content/*`).
 *
 * Auth is dual: a tenant API key (server-side) OR an attempt token scoped to an
 * attempt on this course. The /play page sets that token as a cookie so the
 * SCO's relative sub-resource requests (CSS, images, JS) authenticate
 * automatically.
 */
export function contentRoutes(deps: ContentRouteDeps): FastifyPluginAsync {
  const { prisma, storage } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    app.get<{ Params: { courseId: string; '*': string } }>(
      '/courses/:courseId/content/*',
      async (req, reply) => {
        const { courseId } = req.params;
        const relPath = req.params['*'] ?? '';

        // Reject path traversal before touching storage.
        if (relPath.includes('..') || relPath.startsWith('/')) {
          return reply.code(400).send({ code: 'invalid_path', message: 'Invalid content path' });
        }

        const tenantId = await authorize(app, req, courseId, prisma);
        if (!tenantId) {
          return reply.code(401).send({ code: 'unauthorized', message: 'Content access denied' });
        }

        const course = await prisma.course.findFirst({
          where: { id: courseId, tenantId },
          select: { storageKey: true },
        });
        if (!course) {
          return reply.code(404).send({ code: 'course_not_found', message: 'Course not found' });
        }

        const key = `${course.storageKey}/${relPath}`;
        try {
          const stream = await storage.get(key);
          reply.header('Cache-Control', 'private, max-age=300');
          reply.type(contentTypeFor(relPath));
          return reply.send(stream);
        } catch (err) {
          if (err instanceof StorageNotFoundError) {
            return reply.code(404).send({ code: 'file_not_found', message: 'File not found' });
          }
          throw err;
        }
      },
    );
  };
}

/** Resolve the tenant permitted to read this course's content, or null. */
async function authorize(
  app: FastifyInstance,
  req: FastifyRequest,
  courseId: string,
  prisma: PrismaClient,
): Promise<string | null> {
  if (req.headers['x-api-key']) {
    await app.requireApiKey(req);
    return req.tenantId;
  }
  const token = extractToken(req);
  if (!token) return null;
  const payload = app.verifyAttemptToken(token);
  // The token must be for an attempt on this very course.
  const attempt = await prisma.attempt.findFirst({
    where: { id: payload.attemptId, tenantId: payload.tenantId, courseId },
    select: { id: true },
  });
  return attempt ? payload.tenantId : null;
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
