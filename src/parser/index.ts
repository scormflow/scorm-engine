import { extractZipToStorage, readZipEntry, ZipExtractionError, type ExtractedFile } from './zip.js';
import { parseImsManifest, ManifestParseError, type ParsedManifest } from './manifest.js';

import type { StorageAdapter } from '../storage/types.js';

export {
  extractZipToStorage,
  extractZipToDisk,
  readZipEntry,
  readZipInventory,
  ZipExtractionError,
} from './zip.js';
export type { ExtractedFile, ZipInventory, ZipInventoryEntry } from './zip.js';
export { parseImsManifest, parseManifestTree, ManifestParseError } from './manifest.js';
export type { ParsedManifest, ManifestSco, ScormVersion } from './manifest.js';

export class PackageIngestError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'missing_manifest'
      | 'malformed_manifest'
      | 'malformed_zip'
      | 'no_scos'
      | 'unknown_version'
      | 'invalid_value_type'
      | 'too_large',
  ) {
    super(message);
    this.name = 'PackageIngestError';
  }
}

export interface IngestedPackage {
  manifest: ParsedManifest;
  storagePrefix: string;
  /** Number of files written to storage. */
  fileCount: number;
  /** Every file written, with its size and SHA-256. */
  files: ExtractedFile[];
  /** Total uncompressed bytes written to storage. */
  sizeBytes: number;
}

export interface IngestOptions {
  /**
   * Storage key prefix under which package files are written.
   * E.g. `tenants/{tenantId}/courses/{courseId}`.
   */
  storagePrefix: string;
}

/**
 * End-to-end package ingest: validate manifest, then extract to storage.
 *
 * The manifest is parsed before extraction so that an invalid package fails fast
 * without polluting storage. Once parsing succeeds, the full archive is extracted
 * to the given prefix.
 */
export async function ingestScormPackage(
  buffer: Buffer,
  storage: StorageAdapter,
  options: IngestOptions,
): Promise<IngestedPackage> {
  const manifest = await parsePackageManifest(buffer);

  let extraction;
  try {
    extraction = await extractZipToStorage(buffer, storage, options.storagePrefix);
  } catch (err) {
    if (err instanceof ZipExtractionError) {
      throw new PackageIngestError(err.message, 'malformed_zip');
    }
    throw err;
  }

  return {
    manifest,
    storagePrefix: options.storagePrefix,
    fileCount: extraction.files.length,
    files: extraction.files,
    sizeBytes: extraction.totalBytes,
  };
}

/**
 * Parse the manifest only — no extraction. Used by the `/courses/validate` endpoint
 * and by the upload path for fail-fast validation.
 */
export async function parsePackageManifest(buffer: Buffer): Promise<ParsedManifest> {
  let raw: Buffer | null;
  try {
    raw = await readZipEntry(buffer, 'imsmanifest.xml');
  } catch (err) {
    if (err instanceof ZipExtractionError) {
      throw new PackageIngestError(err.message, 'malformed_zip');
    }
    throw err;
  }

  if (!raw) {
    throw new PackageIngestError(
      "imsmanifest.xml not found at the root of the SCORM package",
      'missing_manifest',
    );
  }

  try {
    return parseImsManifest(raw.toString('utf8'));
  } catch (err) {
    if (err instanceof ManifestParseError) {
      const code = err.code === 'no_scos' ? 'no_scos'
        : err.code === 'unknown_version' ? 'unknown_version'
        : 'malformed_manifest';
      throw new PackageIngestError(err.message, code);
    }
    throw err;
  }
}
