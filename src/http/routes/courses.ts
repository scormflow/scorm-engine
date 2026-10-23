import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';

import {
  createCourseFromUpload,
  validatePackage,
  CourseServiceError,
} from '../../services/courses.js';
import type { PrismaClient } from '../../db/client.js';
import type { StorageAdapter } from '../../storage/types.js';
import { serializeManifest } from '../../services/courses.js';

export interface CoursesRouteDeps {
  prisma: PrismaClient;
  storage: StorageAdapter;
}

export function coursesRoutes(deps: CoursesRouteDeps): FastifyPluginAsync {
  const { prisma, storage } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    app.post('/', { preHandler: app.requireApiKey }, async (req, reply) => {
      const file = await readUploadedFile(req);
      const buffer = await file.toBuffer();
      const title = readField(file, 'title');

      try {
        const course = await createCourseFromUpload(
          { tenantId: req.tenantId, buffer, titleOverride: title },
          { prisma, storage },
        );
        const full = await prisma.course.findUniqueOrThrow({
          where: { id: course.id },
          include: { scos: { orderBy: { order: 'asc' } } },
        });
        reply.code(201);
        return serializeCourse(full);
      } catch (err) {
        if (err instanceof CourseServiceError) {
          return reply.code(err.status).send({
            code: err.code,
            message: err.message,
          });
        }
        throw err;
      }
    });

    app.post('/validate', { preHandler: app.requireApiKey }, async (req) => {
      const file = await readUploadedFile(req);
      const buffer = await file.toBuffer();
      const report = await validatePackage(buffer);
      return {
        valid: report.valid,
        version: report.version,
        errors: report.errors,
        warnings: report.warnings,
        info: report.info,
        stats: report.stats,
        manifest: report.manifest ? serializeManifest(report.manifest) : null,
      };
    });

    app.get('/', { preHandler: app.requireApiKey }, async (req) => {
      const courses = await prisma.course.findMany({
        where: { tenantId: req.tenantId },
        include: { scos: { orderBy: { order: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return {
        data: courses.map(serializeCourse),
        pagination: { nextCursor: null, hasMore: false },
      };
    });

    app.get<{ Params: { id: string } }>('/:id', { preHandler: app.requireApiKey }, async (req, reply) => {
      const course = await prisma.course.findFirst({
        where: { id: req.params.id, tenantId: req.tenantId },
        include: { scos: { orderBy: { order: 'asc' } } },
      });
      if (!course) {
        return reply.code(404).send({ code: 'course_not_found', message: 'Course not found' });
      }
      return serializeCourse(course);
    });

    app.delete<{ Params: { id: string } }>(
      '/:id',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const course = await prisma.course.findFirst({
          where: { id: req.params.id, tenantId: req.tenantId },
          select: { id: true, storageKey: true },
        });
        if (!course) {
          return reply.code(404).send({ code: 'course_not_found', message: 'Course not found' });
        }
        await prisma.course.delete({ where: { id: course.id } });
        try {
          await storage.delete(course.storageKey);
        } catch (err) {
          req.log.warn({ err, storageKey: course.storageKey }, 'storage cleanup failed');
        }
        return reply.code(204).send();
      },
    );
  };
}

async function readUploadedFile(req: FastifyRequest): Promise<MultipartFile> {
  const file = await req.file();
  if (!file) {
    throw req.server.httpErrors.badRequest('Expected a multipart file upload named "file"');
  }
  return file;
}

function readField(file: MultipartFile, name: string): string | undefined {
  const field = file.fields[name];
  if (!field) return undefined;
  const one = Array.isArray(field) ? field[0] : field;
  if (one && typeof one === 'object' && 'value' in one && typeof one.value === 'string') {
    return one.value;
  }
  return undefined;
}

interface SerializableCourse {
  id: string;
  tenantId: string;
  title: string;
  description: string | null;
  scormVersion: string;
  storageKey: string;
  launchUrl: string;
  masteryScore: number | null;
  manifest: unknown;
  createdAt: Date;
  updatedAt: Date;
  scos?: Array<{
    id: string;
    identifier: string;
    title: string;
    launchHref: string;
    parameters: string | null;
    order: number;
  }>;
}

function serializeCourse(course: SerializableCourse): Record<string, unknown> {
  const manifest = course.manifest as Record<string, unknown> | null;
  return {
    id: course.id,
    title: course.title,
    description: course.description,
    version: mapVersionToSpec(course.scormVersion),
    status: 'ready',
    scos: (course.scos ?? []).map((s) => ({
      id: s.id,
      identifier: s.identifier,
      title: s.title,
      launchHref: s.launchHref,
      parameters: s.parameters,
      masteryScore: null,
    })),
    primaryScoId: manifest && typeof manifest['primaryScoId'] === 'string'
      ? (manifest['primaryScoId'] as string)
      : course.scos?.[0]?.identifier ?? null,
    masteryScore: course.masteryScore,
    manifest: manifest
      ? {
          identifier: manifest['identifier'] ?? null,
          title: manifest['title'] ?? course.title,
          description: manifest['description'] ?? course.description,
          keywords: manifest['keywords'] ?? [],
          schemaVersion: manifest['schemaVersion'] ?? null,
          defaultOrganization: manifest['defaultOrganizationId'] ?? null,
        }
      : null,
    sizeBytes: 0,
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString(),
  };
}

function mapVersionToSpec(prismaVersion: string): string {
  switch (prismaVersion) {
    case 'SCORM_12':
      return 'SCORM_1_2';
    default:
      return prismaVersion;
  }
}
