import { createHash } from 'node:crypto';

import type { CourseVersion, Prisma, PrismaClient } from '@prisma/client';

import {
  ingestScormPackage,
  PackageIngestError,
  type ExtractedFile,
  type ParsedManifest,
} from '../parser/index.js';
import { tenantKey } from '../storage/scoped.js';
import type { StorageAdapter } from '../storage/types.js';
import type { EventSink } from '../webhooks/events.js';
import { diffVersions, type DiffableVersion, type VersionDiff, type VersionFile, type VersionSco } from './diff.js';

export class CourseVersionError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 422,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CourseVersionError';
  }
}

export interface CourseVersionDeps {
  prisma: PrismaClient;
  storage: StorageAdapter;
  events?: EventSink | undefined;
}

/** What a newly ingested package contributes to its release row. */
export interface IngestedRelease {
  manifest: ParsedManifest;
  storageKey: string;
  files: ExtractedFile[];
  sizeBytes: number;
  packageSha256: string;
}

export interface PublishVersionInput {
  tenantId: string;
  courseId: string;
  buffer: Buffer;
  /** Explicit release label; otherwise the previous label is bumped. */
  label?: string | undefined;
  /** Which part of an `X.Y` label to bump when `label` is omitted. Default `minor`. */
  bump?: 'major' | 'minor' | undefined;
  releaseNotes?: string | undefined;
  titleOverride?: string | undefined;
  /** Publish without making the release live (default: activate it). */
  activate?: boolean | undefined;
}

export interface CourseVersionView {
  id: string;
  courseId: string;
  number: number;
  label: string;
  releaseNotes: string | null;
  current: boolean;
  title: string;
  description: string | null;
  scormVersion: string;
  masteryScore: number | null;
  launchHref: string;
  scoCount: number;
  fileCount: number;
  sizeBytes: number;
  packageSha256: string | null;
  createdAt: string;
}

export const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MAX_NOTES = 10_000;

const VERSION_MAP = {
  SCORM_1_2: 'SCORM_12',
  SCORM_2004_2: 'SCORM_2004_2',
  SCORM_2004_3: 'SCORM_2004_3',
  SCORM_2004_4: 'SCORM_2004_4',
} as const;

/** Storage prefix for release `number` (> 1) of a course. Release 1 keeps the course's own prefix. */
export function versionStorageKey(tenantId: string, courseId: string, number: number): string {
  return tenantKey(tenantId, 'course-versions', courseId, String(number));
}

/** SHA-256 of an uploaded package. */
export function packageSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Columns of `Course` that mirror its live release. */
export function headColumns(release: {
  title: string;
  description: string | null;
  scormVersion: CourseVersion['scormVersion'];
  storageKey: string;
  launchUrl: string;
  masteryScore: number | null;
  manifest: unknown;
}) {
  return {
    title: release.title,
    description: release.description,
    scormVersion: release.scormVersion,
    storageKey: release.storageKey,
    launchUrl: release.launchUrl,
    masteryScore: release.masteryScore,
    manifest: release.manifest as Prisma.InputJsonValue,
  };
}

/** Row data for a release built from a freshly ingested package. */
export function releaseData(
  release: IngestedRelease,
  serializedManifest: Record<string, unknown>,
  titleOverride: string | undefined,
) {
  const { manifest, storageKey } = release;
  return {
    title: titleOverride?.trim() || manifest.title,
    description: manifest.description,
    scormVersion: VERSION_MAP[manifest.version],
    storageKey,
    launchUrl: `${storageKey}/${manifest.primarySco.launchHref}`,
    masteryScore: manifest.masteryScore,
    manifest: serializedManifest as Prisma.InputJsonValue,
    files: release.files.map((f) => ({ path: f.path, sizeBytes: f.sizeBytes, sha256: f.sha256 })),
    fileCount: release.files.length,
    sizeBytes: BigInt(release.sizeBytes),
    packageSha256: release.packageSha256,
  };
}

/** The label after `previous`: `1.3` → `1.4` (minor) or `2.0` (major); anything else → `<number>.0`. */
export function nextLabel(previous: string | null, number: number, bump: 'major' | 'minor' = 'minor'): string {
  const match = previous ? /^(v?)(\d+)\.(\d+)$/.exec(previous) : null;
  if (!match) return `${number}.0`;
  const [, prefix, major, minor] = match;
  return bump === 'major' ? `${prefix}${Number(major) + 1}.0` : `${prefix}${major}.${Number(minor) + 1}`;
}

export function createCourseVersionService(deps: CourseVersionDeps) {
  const { prisma, storage, events } = deps;

  async function loadCourse(tenantId: string, courseId: string) {
    const course = await prisma.course.findFirst({ where: { id: courseId, tenantId } });
    if (!course) throw new CourseVersionError(404, 'course_not_found', 'Course not found');
    return course;
  }

  async function loadVersion(courseId: string, number: number): Promise<CourseVersion> {
    if (!Number.isInteger(number) || number < 1) {
      throw new CourseVersionError(400, 'invalid_request', 'Version number must be a positive integer');
    }
    const version = await prisma.courseVersion.findFirst({ where: { courseId, number } });
    if (!version) throw new CourseVersionError(404, 'version_not_found', `Course has no version ${number}`);
    return version;
  }

  /**
   * Courses uploaded before versioning have no release rows. Record their
   * current content as release 1 (without a file inventory) so the history
   * starts from what learners have been taking.
   */
  async function ensureBaseline(course: Awaited<ReturnType<typeof loadCourse>>): Promise<void> {
    if (course.currentVersionId) return;
    const existing = await prisma.courseVersion.count({ where: { courseId: course.id } });
    if (existing > 0) return;
    const baseline = await prisma.courseVersion.create({
      data: {
        tenantId: course.tenantId,
        courseId: course.id,
        number: 1,
        label: '1.0',
        ...headColumns(course),
        packageSha256: null,
      },
    });
    await prisma.course.update({ where: { id: course.id }, data: { currentVersionId: baseline.id } });
  }

  /** Point the course at `version` and bring its SCO rows in line with that release. */
  async function activate(courseId: string, version: CourseVersion): Promise<void> {
    const scos = manifestScos(version.manifest);
    await prisma.$transaction(async (tx) => {
      await tx.course.update({
        where: { id: courseId },
        data: { ...headColumns(version), currentVersionId: version.id },
      });
      // Upsert by identifier so attempts keep their SCO link across releases.
      const existing = await tx.sco.findMany({ where: { courseId }, select: { id: true, identifier: true } });
      const keep = new Set(scos.map((s) => s.identifier));
      const doomed = existing.filter((s) => !keep.has(s.identifier)).map((s) => s.id);
      if (doomed.length > 0) await tx.sco.deleteMany({ where: { id: { in: doomed } } });
      for (const [order, sco] of scos.entries()) {
        const fields = { title: sco.title, launchHref: sco.launchHref, parameters: sco.parameters, order };
        await tx.sco.upsert({
          where: { courseId_identifier: { courseId, identifier: sco.identifier } },
          update: fields,
          create: { courseId, identifier: sco.identifier, ...fields },
        });
      }
    }, { timeout: 30_000 });
  }

  return {
    async list(tenantId: string, courseId: string): Promise<{ data: CourseVersionView[]; currentVersion: number | null }> {
      const course = await loadCourse(tenantId, courseId);
      const versions = await prisma.courseVersion.findMany({
        where: { courseId: course.id },
        orderBy: { number: 'desc' },
      });
      const current = versions.find((v) => v.id === course.currentVersionId);
      return {
        data: versions.map((v) => toView(v, course.currentVersionId)),
        currentVersion: current?.number ?? null,
      };
    },

    async get(tenantId: string, courseId: string, number: number): Promise<CourseVersionView> {
      const course = await loadCourse(tenantId, courseId);
      return toView(await loadVersion(course.id, number), course.currentVersionId);
    },

    async publish(
      input: PublishVersionInput,
      serialize: (manifest: ParsedManifest) => Record<string, unknown>,
    ): Promise<CourseVersionView> {
      const course = await loadCourse(input.tenantId, input.courseId);
      if (input.label !== undefined && !LABEL_PATTERN.test(input.label)) {
        throw new CourseVersionError(
          400,
          'invalid_request',
          'label must be 1–32 characters of letters, digits, ".", "_" or "-", starting with a letter or digit',
        );
      }
      if (input.releaseNotes !== undefined && input.releaseNotes.length > MAX_NOTES) {
        throw new CourseVersionError(400, 'invalid_request', `releaseNotes must be at most ${MAX_NOTES} characters`);
      }
      await ensureBaseline(course);

      const latest = await prisma.courseVersion.findFirst({
        where: { courseId: course.id },
        orderBy: { number: 'desc' },
      });
      const number = (latest?.number ?? 0) + 1;
      const label = input.label ?? nextLabel(latest?.label ?? null, number, input.bump);
      const clash = await prisma.courseVersion.findFirst({ where: { courseId: course.id, label } });
      if (clash) {
        throw new CourseVersionError(409, 'version_label_taken', `Version label "${label}" is already used`);
      }

      const storageKey = versionStorageKey(input.tenantId, course.id, number);
      let ingest;
      try {
        ingest = await ingestScormPackage(input.buffer, storage, { storagePrefix: storageKey });
      } catch (err) {
        if (err instanceof PackageIngestError) {
          throw new CourseVersionError(err.code === 'too_large' ? 400 : 422, err.code, err.message);
        }
        throw err;
      }

      let version: CourseVersion;
      try {
        version = await prisma.courseVersion.create({
          data: {
            tenantId: input.tenantId,
            courseId: course.id,
            number,
            label,
            releaseNotes: input.releaseNotes ?? null,
            ...releaseData(
              {
                manifest: ingest.manifest,
                storageKey,
                files: ingest.files,
                sizeBytes: ingest.sizeBytes,
                packageSha256: packageSha256(input.buffer),
              },
              serialize(ingest.manifest),
              input.titleOverride,
            ),
          },
        });
      } catch (err) {
        await storage.delete(storageKey).catch(() => undefined);
        // Two publishes raced for the same number or label.
        if ((err as { code?: unknown }).code === 'P2002') {
          throw new CourseVersionError(409, 'version_conflict', 'Another release was published concurrently; retry');
        }
        throw err;
      }

      const live = input.activate !== false;
      if (live) await activate(course.id, version);
      events?.emit(input.tenantId, 'course.version.published', {
        courseId: course.id,
        version: version.number,
        label: version.label,
        activated: live,
      });
      return toView(version, live ? version.id : course.currentVersionId);
    },

    async updateNotes(
      tenantId: string,
      courseId: string,
      number: number,
      releaseNotes: string | null,
    ): Promise<CourseVersionView> {
      if (releaseNotes !== null && (typeof releaseNotes !== 'string' || releaseNotes.length > MAX_NOTES)) {
        throw new CourseVersionError(400, 'invalid_request', `releaseNotes must be a string of at most ${MAX_NOTES} characters, or null`);
      }
      const course = await loadCourse(tenantId, courseId);
      const version = await loadVersion(course.id, number);
      const updated = await prisma.courseVersion.update({ where: { id: version.id }, data: { releaseNotes } });
      return toView(updated, course.currentVersionId);
    },

    /** Make an existing release live again. New attempts launch it; running attempts stay pinned. */
    async rollback(tenantId: string, courseId: string, number: number): Promise<CourseVersionView> {
      const course = await loadCourse(tenantId, courseId);
      const target = await loadVersion(course.id, number);
      const previous = course.currentVersionId
        ? await prisma.courseVersion.findFirst({ where: { id: course.currentVersionId }, select: { number: true } })
        : null;
      if (target.id !== course.currentVersionId) {
        await activate(course.id, target);
        events?.emit(tenantId, 'course.version.rolled_back', {
          courseId: course.id,
          version: target.number,
          label: target.label,
          previousVersion: previous?.number ?? null,
        });
      }
      return toView(target, target.id);
    },

    /** Diff two releases. `to` defaults to the live release, `from` to the release before `to`. */
    async diff(
      tenantId: string,
      courseId: string,
      query: { from?: number | undefined; to?: number | undefined },
    ): Promise<VersionDiff> {
      const course = await loadCourse(tenantId, courseId);
      let toNumber = query.to;
      if (toNumber === undefined) {
        const current = course.currentVersionId
          ? await prisma.courseVersion.findFirst({ where: { id: course.currentVersionId }, select: { number: true } })
          : null;
        if (!current) throw new CourseVersionError(404, 'version_not_found', 'Course has no versions yet');
        toNumber = current.number;
      }
      const fromNumber = query.from ?? toNumber - 1;
      if (fromNumber < 1) {
        throw new CourseVersionError(400, 'invalid_request', `Version ${toNumber} has no earlier version; pass ?from=`);
      }
      const [from, to] = await Promise.all([loadVersion(course.id, fromNumber), loadVersion(course.id, toNumber)]);
      return diffVersions(diffable(from), diffable(to));
    },
  };
}

export type CourseVersionService = ReturnType<typeof createCourseVersionService>;

function toView(version: CourseVersion, currentVersionId: string | null): CourseVersionView {
  return {
    id: version.id,
    courseId: version.courseId,
    number: version.number,
    label: version.label,
    releaseNotes: version.releaseNotes,
    current: version.id === currentVersionId,
    title: version.title,
    description: version.description,
    scormVersion: version.scormVersion === 'SCORM_12' ? 'SCORM_1_2' : version.scormVersion,
    masteryScore: version.masteryScore,
    launchHref: relativeLaunch(version),
    scoCount: manifestScos(version.manifest).length,
    fileCount: version.fileCount,
    sizeBytes: Number(version.sizeBytes),
    packageSha256: version.packageSha256,
    createdAt: version.createdAt.toISOString(),
  };
}

function diffable(version: CourseVersion): DiffableVersion {
  return {
    number: version.number,
    label: version.label,
    title: version.title,
    description: version.description,
    scormVersion: version.scormVersion === 'SCORM_12' ? 'SCORM_1_2' : version.scormVersion,
    masteryScore: version.masteryScore,
    launchHref: relativeLaunch(version),
    scos: manifestScos(version.manifest),
    files: Array.isArray(version.files) ? (version.files as unknown as VersionFile[]) : null,
  };
}

function relativeLaunch(version: { storageKey: string; launchUrl: string }): string {
  const prefix = `${version.storageKey}/`;
  return version.launchUrl.startsWith(prefix) ? version.launchUrl.slice(prefix.length) : version.launchUrl;
}

/** The SCO list stored in a serialized manifest (see `serializeManifest`). */
export function manifestScos(manifest: unknown): VersionSco[] {
  const scos = (manifest as { scos?: unknown } | null)?.scos;
  if (!Array.isArray(scos)) return [];
  return scos
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof s.identifier === 'string')
    .map((s) => ({
      identifier: s.identifier as string,
      title: typeof s.title === 'string' ? s.title : (s.identifier as string),
      launchHref: typeof s.launchHref === 'string' ? s.launchHref : '',
      parameters: typeof s.parameters === 'string' ? s.parameters : null,
    }));
}
