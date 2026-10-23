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
import type { EventSink } from '../../webhooks/events.js';
import { createCourseVersionService, CourseVersionError, LABEL_PATTERN } from '../../versioning/index.js';

export interface CoursesRouteDeps {
  prisma: PrismaClient;
  storage: StorageAdapter;
  events?: EventSink | undefined;
}

const COURSE_INCLUDE = {
  scos: { orderBy: { order: 'asc' } },
  currentVersion: { select: { number: true, label: true } },
} as const;

export function coursesRoutes(deps: CoursesRouteDeps): FastifyPluginAsync {
  const { prisma, storage } = deps;
  const versions = createCourseVersionService(deps);

  return async function (app: FastifyInstance): Promise<void> {
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof CourseVersionError) {
        return reply.code(err.status).send({ code: err.code, message: err.message });
      }
      return reply.send(err);
    });

    app.post('/', { preHandler: app.requireApiKey }, async (req, reply) => {
      const file = await readUploadedFile(req);
      const buffer = await file.toBuffer();
      const title = readField(file, 'title');
      const label = readField(file, 'label');
      if (label !== undefined && !LABEL_PATTERN.test(label)) {
        return reply.code(400).send({ code: 'invalid_request', message: 'label must be 1–32 characters of letters, digits, ".", "_" or "-"' });
      }

      try {
        const course = await createCourseFromUpload(
          {
            tenantId: req.tenantId,
            buffer,
            titleOverride: title,
            versionLabel: label,
            releaseNotes: readField(file, 'releaseNotes'),
          },
          { prisma, storage },
        );
        const full = await prisma.course.findUniqueOrThrow({
          where: { id: course.id },
          include: COURSE_INCLUDE,
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
        include: COURSE_INCLUDE,
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
        include: COURSE_INCLUDE,
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
        const releases = await prisma.courseVersion.findMany({
          where: { courseId: course.id },
          select: { storageKey: true },
        });
        await prisma.course.delete({ where: { id: course.id } });
        for (const storageKey of new Set([course.storageKey, ...releases.map((r) => r.storageKey)])) {
          try {
            await storage.delete(storageKey);
          } catch (err) {
            req.log.warn({ err, storageKey }, 'storage cleanup failed');
          }
        }
        return reply.code(204).send();
      },
    );

    // --- Versioning: releases, changelog, diff, rollback ---

    app.get<{ Params: { id: string } }>('/:id/versions', { preHandler: app.requireApiKey }, async (req) =>
      versions.list(req.tenantId, req.params.id),
    );

    app.post<{ Params: { id: string } }>('/:id/versions', { preHandler: app.requireApiKey }, async (req, reply) => {
      const file = await readUploadedFile(req);
      const buffer = await file.toBuffer();
      const bump = readField(file, 'bump');
      if (bump !== undefined && bump !== 'major' && bump !== 'minor') {
        return reply.code(400).send({ code: 'invalid_request', message: 'bump must be "major" or "minor"' });
      }
      const activate = readField(file, 'activate');
      const version = await versions.publish(
        {
          tenantId: req.tenantId,
          courseId: req.params.id,
          buffer,
          label: readField(file, 'label'),
          bump,
          releaseNotes: readField(file, 'releaseNotes'),
          titleOverride: readField(file, 'title'),
          activate: activate === undefined ? undefined : activate !== 'false' && activate !== '0',
        },
        serializeManifest,
      );
      reply.code(201);
      return version;
    });

    app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
      '/:id/versions/diff',
      { preHandler: app.requireApiKey },
      async (req) =>
        versions.diff(req.tenantId, req.params.id, {
          from: optionalNumber(req.query.from),
          to: optionalNumber(req.query.to),
        }),
    );

    app.get<{ Params: { id: string; number: string } }>(
      '/:id/versions/:number',
      { preHandler: app.requireApiKey },
      async (req) => versions.get(req.tenantId, req.params.id, Number(req.params.number)),
    );

    app.patch<{ Params: { id: string; number: string }; Body: { releaseNotes?: unknown } }>(
      '/:id/versions/:number',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const notes = req.body?.releaseNotes;
        if (notes !== null && typeof notes !== 'string') {
          return reply.code(400).send({ code: 'invalid_request', message: 'releaseNotes must be a string or null' });
        }
        return versions.updateNotes(req.tenantId, req.params.id, Number(req.params.number), notes);
      },
    );

    app.post<{ Params: { id: string }; Body: { version?: unknown } }>(
      '/:id/rollback',
      { preHandler: app.requireApiKey },
      async (req, reply) => {
        const target = req.body?.version;
        if (typeof target !== 'number' || !Number.isInteger(target)) {
          return reply.code(400).send({ code: 'invalid_request', message: 'version must be an integer release number' });
        }
        return versions.rollback(req.tenantId, req.params.id, target);
      },
    );
  };
}

/** Parse an optional integer query param; non-numeric input becomes NaN so the service rejects it. */
function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined || value === '' ? undefined : Number(value);
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
  currentVersion?: { number: number; label: string } | null;
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
    currentVersion: course.currentVersion
      ? { number: course.currentVersion.number, label: course.currentVersion.label }
      : null,
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
