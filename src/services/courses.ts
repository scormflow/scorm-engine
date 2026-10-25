import { randomUUID } from 'node:crypto';

import type { Course, PrismaClient } from '@prisma/client';

import { ingestScormPackage, PackageIngestError, type ParsedManifest } from '../parser/index.js';
import { tenantKey } from '../storage/scoped.js';
import { headColumns, packageSha256, releaseData } from '../versioning/service.js';
import type { StorageAdapter } from '../storage/types.js';
import { validateScormPackage } from '../validator/validate.js';
import type { PackageValidationReport, ValidatePackageOptions } from '../validator/types.js';

export class CourseServiceError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_package'
      | 'missing_manifest'
      | 'no_scos'
      | 'unsupported_version'
      | 'too_large',
    public readonly status: 400 | 422 = 422,
  ) {
    super(message);
    this.name = 'CourseServiceError';
  }
}

export interface CreateCourseInput {
  tenantId: string;
  buffer: Buffer;
  /** Optional override for the title parsed from the manifest. */
  titleOverride?: string | undefined;
  /** Label for release 1 (default `1.0`). */
  versionLabel?: string | undefined;
  releaseNotes?: string | undefined;
}

export interface CreateCourseDeps {
  prisma: PrismaClient;
  storage: StorageAdapter;
}

export interface ValidatePackageDeps {
  // Validation does not touch the DB or storage.
}

export type ValidationReport = PackageValidationReport;

/**
 * Upload + parse + persist a SCORM package.
 *
 * Flow:
 *  1. Parse the manifest from the in-memory buffer (fail fast on bad packages).
 *  2. Allocate a course ID up-front so the storage prefix is stable.
 *  3. Extract package files to storage under that prefix.
 *  4. Persist Course + Sco rows and release 1 (`CourseVersion`) in one transaction.
 *
 * If DB persistence fails after extraction, the storage files are deleted to avoid orphans.
 */
export async function createCourseFromUpload(
  input: CreateCourseInput,
  deps: CreateCourseDeps,
): Promise<Course> {
  const { tenantId, buffer, titleOverride, versionLabel, releaseNotes } = input;
  const { prisma, storage } = deps;

  const courseId = randomUUID();
  const storagePrefix = tenantKey(tenantId, 'courses', courseId);

  let ingest;
  try {
    ingest = await ingestScormPackage(buffer, storage, { storagePrefix });
  } catch (err) {
    if (err instanceof PackageIngestError) {
      throw mapIngestError(err);
    }
    throw err;
  }

  const { manifest } = ingest;
  const release = releaseData(
    { manifest, storageKey: storagePrefix, files: ingest.files, sizeBytes: ingest.sizeBytes, packageSha256: packageSha256(buffer) },
    serializeManifest(manifest),
    titleOverride,
  );

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.course.create({
        data: {
          id: courseId,
          tenantId,
          ...headColumns(release),
          scos: {
            create: manifest.scos.map((sco, idx) => ({
              identifier: sco.identifier,
              title: sco.title,
              launchHref: sco.launchHref,
              parameters: sco.parameters,
              order: idx,
            })),
          },
        },
      });
      // Release 1 shares the course's storage prefix; later releases get their own.
      const version = await tx.courseVersion.create({
        data: { tenantId, courseId, number: 1, label: versionLabel ?? '1.0', releaseNotes: releaseNotes ?? null, ...release },
      });
      return tx.course.update({ where: { id: courseId }, data: { currentVersionId: version.id } });
    });
  } catch (err) {
    // Best-effort cleanup of orphaned storage.
    try {
      await storage.delete(storagePrefix);
    } catch {
      // Swallow — original error wins.
    }
    throw err;
  }
}

/**
 * Parse and validate a SCORM package without persisting it. Runs the full
 * validator (structure, manifest, launch files, runtime API, accessibility,
 * assets); `valid` is false only for `error`-severity issues.
 */
export async function validatePackage(
  buffer: Buffer,
  options: ValidatePackageOptions = {},
): Promise<ValidationReport> {
  return validateScormPackage(buffer, { accept: 'scorm', ...options });
}

export function serializeManifest(manifest: ParsedManifest): Record<string, unknown> {
  return {
    identifier: manifest.identifier,
    title: manifest.title,
    description: manifest.description,
    keywords: manifest.keywords,
    schemaVersion: manifest.schemaVersion,
    defaultOrganizationId: manifest.defaultOrganizationId,
    scos: manifest.scos,
    primaryScoId: manifest.primarySco.identifier,
    resourceFiles: manifest.resourceFiles,
  };
}

function mapIngestError(err: PackageIngestError): CourseServiceError {
  switch (err.code) {
    case 'missing_manifest':
      return new CourseServiceError(err.message, 'missing_manifest');
    case 'no_scos':
      return new CourseServiceError(err.message, 'no_scos');
    case 'unknown_version':
      return new CourseServiceError(err.message, 'unsupported_version');
    case 'too_large':
      return new CourseServiceError(err.message, 'too_large', 400);
    case 'malformed_zip':
    case 'malformed_manifest':
    case 'invalid_value_type':
    default:
      return new CourseServiceError(err.message, 'invalid_package');
  }
}
