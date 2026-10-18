import path from 'node:path';

import { CourseStructureError, parseCourseStructure, type ParsedCourseStructure } from '../cmi5/course-structure.js';
import {
  ManifestParseError,
  parseImsManifest,
  parseManifestTree,
  type ParsedManifest,
} from '../parser/manifest.js';
import { readZipInventory, ZipExtractionError, type ZipInventory } from '../parser/zip.js';
import {
  FileIndex,
  HTML_EXT,
  SCANNED_EXT,
  checkAccessibility,
  checkAssets,
  checkEntries,
  checkManifest,
  checkRuntimeApi,
  findNestedManifest,
  resolveHref,
  scanRuntime,
  type RuntimeScan,
} from './checks.js';
import { IssueCollector } from './collector.js';
import type { PackageType, PackageValidationReport, ValidatePackageOptions } from './types.js';

const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 16 * 1024 * 1024;
const DESCRIPTORS = new Set(['imsmanifest.xml', 'cmi5.xml']);

/**
 * Validate a SCORM (or, with `accept: 'any'`, cmi5) package ZIP without
 * extracting or persisting anything.
 *
 * Checks: archive structure, manifest well-formedness and identifier
 * integrity, launch / resource files, runtime API and CMI data model
 * compatibility, basic accessibility, and asset size / format.
 */
export async function validateScormPackage(
  buffer: Buffer,
  options: ValidatePackageOptions = {},
): Promise<PackageValidationReport> {
  const accept = options.accept ?? 'scorm';
  const issues = new IssueCollector(options.maxIssuesPerCode ?? 25);
  let inventory: ZipInventory | undefined;
  let packageType: PackageType = 'unknown';
  let manifest: ParsedManifest | null = null;
  let cmi5Structure: ParsedCourseStructure | null = null;
  let launchableCount = 0;
  let scannedFiles = 0;

  const report = (): PackageValidationReport => {
    const all = issues.result();
    const errors = all.filter((i) => i.severity === 'error');
    return {
      valid: errors.length === 0,
      packageType,
      version: manifest?.version ?? null,
      manifest,
      cmi5Structure,
      errors,
      warnings: all.filter((i) => i.severity === 'warning'),
      info: all.filter((i) => i.severity === 'info'),
      stats: {
        fileCount: inventory?.entries.length ?? 0,
        totalBytes: inventory?.totalBytes ?? 0,
        launchableCount,
        scannedFiles,
      },
    };
  };

  try {
    inventory = await readZipInventory(buffer, {
      readContent: (p, size) => {
        const lower = p.toLowerCase();
        if (DESCRIPTORS.has(lower)) return size <= MAX_DESCRIPTOR_BYTES;
        if (p.startsWith('__MACOSX/')) return false;
        return SCANNED_EXT.has(path.posix.extname(lower)) && size <= MAX_SCANNED_FILE_BYTES;
      },
    });
  } catch (err) {
    if (err instanceof ZipExtractionError) {
      issues.error('structure', 'malformed_zip', err.message);
      return report();
    }
    throw err;
  }

  const { entries, contents, totalBytes } = inventory;
  checkEntries(entries, issues);
  const files = new FileIndex(entries);
  const descriptor = (name: string) => entries.find((e) => !e.unsafe && e.path.toLowerCase() === name);
  const manifestEntry = descriptor('imsmanifest.xml');
  const cmi5Entry = descriptor('cmi5.xml');

  if (manifestEntry) {
    packageType = 'scorm';
    const xml = contents.get(manifestEntry.path);
    if (!xml) {
      issues.error('structure', 'too_large', 'imsmanifest.xml is larger than 16 MiB');
    } else {
      try {
        const text = xml.toString('utf8');
        const tree = parseManifestTree(text);
        manifest = parseImsManifest(text);
        launchableCount = manifest.scos.length;
        checkManifest(tree, manifest, files, issues);
      } catch (err) {
        if (!(err instanceof ManifestParseError)) throw err;
        const code = err.code === 'no_scos' || err.code === 'unknown_version' ? err.code : 'malformed_manifest';
        issues.error('manifest', code, err.message, manifestEntry.path);
      }
    }
  } else if (cmi5Entry && accept === 'any') {
    packageType = 'cmi5';
    const xml = contents.get(cmi5Entry.path);
    if (!xml) {
      issues.error('structure', 'too_large', 'cmi5.xml is larger than 16 MiB');
    } else {
      try {
        cmi5Structure = parseCourseStructure(xml.toString('utf8'));
        launchableCount = cmi5Structure.aus.length;
        for (const au of cmi5Structure.aus) {
          const resolved = resolveHref(au.url);
          if (resolved !== null && !files.has(resolved)) {
            const variant = files.caseVariant(resolved);
            if (variant) {
              issues.warn(
                'resources',
                'path_case_mismatch',
                `AU '${au.id}' references '${resolved}' but the package contains '${variant}'`,
                resolved,
              );
            } else {
              issues.error(
                'resources',
                'missing_launch_file',
                `Launch file '${resolved}' for AU '${au.id}' is not in the package`,
                resolved,
              );
            }
          }
        }
      } catch (err) {
        if (!(err instanceof CourseStructureError)) throw err;
        issues.error('manifest', err.code === 'malformed_xml' ? 'malformed_manifest' : err.code, err.message, cmi5Entry.path);
      }
    }
  } else if (cmi5Entry) {
    issues.error(
      'structure',
      'missing_manifest',
      'This is a cmi5 package (cmi5.xml, no imsmanifest.xml); import it through POST /cmi5/courses instead',
    );
  } else {
    const nested = findNestedManifest(entries, 'imsmanifest.xml');
    if (nested) {
      issues.error(
        'structure',
        'manifest_not_at_root',
        `imsmanifest.xml was found at '${nested}' but must be at the root of the ZIP; ` +
          'zip the contents of the course folder, not the folder itself',
        nested,
      );
    } else {
      issues.error('structure', 'missing_manifest', 'imsmanifest.xml not found at the root of the package');
    }
  }

  if (packageType !== 'unknown') {
    const scans: RuntimeScan[] = [];
    for (const [filePath, data] of contents) {
      const ext = path.posix.extname(filePath).toLowerCase();
      if (!SCANNED_EXT.has(ext)) continue;
      scannedFiles++;
      const text = data.toString('utf8');
      if (manifest) scans.push(scanRuntime(filePath, text, manifest.version, issues));
      if (HTML_EXT.has(ext)) checkAccessibility(filePath, text, issues);
    }
    if (manifest) checkRuntimeApi(manifest.version, scans, issues);
  }

  checkAssets(
    entries,
    totalBytes,
    {
      largeAssetBytes: options.largeAssetBytes ?? 50 * 1024 * 1024,
      largePackageBytes: options.largePackageBytes ?? 500 * 1024 * 1024,
      largeImageBytes: options.largeImageBytes ?? 1024 * 1024,
    },
    issues,
  );

  return report();
}
