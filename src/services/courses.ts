import { randomUUID } from 'node:crypto';

import type { Course, PrismaClient, ScormVersion as PrismaScormVersion, Prisma } from '@prisma/client';

import {
  ingestScormPackage,
  PackageIngestError,
  type ParsedManifest,
  type ScormVersion as ManifestScormVersion,
} from '../parser/index.js';
import { tenantKey } from '../storage/scoped.js';
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
}

export interface CreateCourseDeps {
  prisma: PrismaClient;
  storage: StorageAdapter;
}

export interface ValidatePackageDeps {
  // Validation does not touch the DB or storage.
}

export type ValidationReport = PackageValidationReport;

const VERSION_MAP: Record<ManifestScormVersion, PrismaScormVersion> = {
  SCORM_1_2: 'SCORM_12',
  SCORM_2004_2: 'SCORM_2004_2',
  SCORM_2004_3: 'SCORM_2004_3',
  SCORM_2004_4: 'SCORM_2004_4',
};

/**
 * Upload + parse + persist a SCORM package.
 *
 * Flow:
 *  1. Parse the manifest from the in-memory buffer (fail fast on bad packages).
 *  2. Allocate a course ID up-front so the storage prefix is stable.
 *  3. Extract package files to storage under that prefix.
 *  4. Persist Course + Sco rows in a single transaction.
 *
 * If DB persistence fails after extraction, the storage files are deleted to avoid orphans.
 */
export async function createCourseFromUpload(
  input: CreateCourseInput,
  deps: CreateCourseDeps,
): Promise<Course> {
  const { tenantId, buffer, titleOverride } = input;
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
  const launchUrl = `${storagePrefix}/${manifest.primarySco.launchHref}`;
  const title = titleOverride?.trim() || manifest.title;

  try {
    const course = await prisma.course.create({
      data: {
        id: courseId,
        tenantId,
        title,
        description: manifest.description,
        scormVersion: VERSION_MAP[manifest.version],
        storageKey: storagePrefix,
        launchUrl,
        masteryScore: manifest.masteryScore,
        manifest: serializeManifest(manifest) as Prisma.InputJsonValue,
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
    return course;
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
