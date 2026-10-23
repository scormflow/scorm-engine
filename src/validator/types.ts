import type { ParsedManifest, ScormVersion } from '../parser/manifest.js';
import type { ParsedCourseStructure } from '../cmi5/course-structure.js';

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueCategory =
  | 'structure'
  | 'manifest'
  | 'resources'
  | 'runtime'
  | 'accessibility'
  | 'assets';

export interface ValidationIssue {
  /** Stable machine-readable code, e.g. `missing_launch_file`. */
  code: string;
  severity: IssueSeverity;
  category: IssueCategory;
  message: string;
  /** Package-relative file the issue is about, when there is one. */
  path: string | null;
}

export type PackageType = 'scorm' | 'cmi5' | 'unknown';

export interface PackageValidationReport {
  /** True when there are no `error`-severity issues. */
  valid: boolean;
  packageType: PackageType;
  version: ScormVersion | null;
  manifest: ParsedManifest | null;
  /** The parsed `cmi5.xml`, for cmi5 packages. */
  cmi5Structure: ParsedCourseStructure | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  info: ValidationIssue[];
  stats: {
    fileCount: number;
    totalBytes: number;
    /** SCOs (SCORM) or AUs (cmi5) found. */
    launchableCount: number;
    /** HTML / JS files whose contents were scanned. */
    scannedFiles: number;
  };
}

export interface ValidatePackageOptions {
  /**
   * `scorm` (default) treats anything other than a SCORM package as invalid —
   * that is what `POST /courses` accepts. `any` also validates cmi5 packages.
   */
  accept?: 'scorm' | 'any';
  /** Largest single file before `large_asset` fires. Defaults to 50 MiB. */
  largeAssetBytes?: number;
  /** Package size before `large_package` fires. Defaults to 500 MiB. */
  largePackageBytes?: number;
  /** Image size before `unoptimized_image` fires. Defaults to 1 MiB. */
  largeImageBytes?: number;
  /** Most issues reported per code before they are summarised. Defaults to 25. */
  maxIssuesPerCode?: number;
}
