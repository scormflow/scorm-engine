import type { ScormVersion } from '../parser/manifest.js';
import { formatBytes } from './checks.js';
import type { PackageValidationReport, ValidationIssue } from './types.js';

const VERSION_LABEL: Record<ScormVersion, string> = {
  SCORM_1_2: 'SCORM 1.2',
  SCORM_2004_2: 'SCORM 2004 2nd Edition',
  SCORM_2004_3: 'SCORM 2004 3rd Edition',
  SCORM_2004_4: 'SCORM 2004 4th Edition',
};

const LABEL: Record<ValidationIssue['severity'], string> = {
  error: 'ERROR',
  warning: 'WARN ',
  info: 'INFO ',
};

/** Human-readable report used by the `scormflow validate` CLI. */
export function formatReport(report: PackageValidationReport, source: string): string {
  const lines: string[] = [];
  const kind =
    report.packageType === 'scorm'
      ? (report.version ? VERSION_LABEL[report.version] : 'SCORM')
      : report.packageType === 'cmi5'
        ? 'cmi5'
        : 'unknown package type';
  const title = report.manifest?.title ?? report.cmi5Structure?.title ?? null;

  lines.push(`${source}: ${kind}${title ? ` — "${title}"` : ''}`);
  lines.push(
    `  ${report.stats.fileCount} files, ${formatBytes(report.stats.totalBytes)}, ` +
      `${report.stats.launchableCount} ${report.packageType === 'cmi5' ? 'AU' : 'SCO'}(s), ` +
      `${report.stats.scannedFiles} HTML/JS file(s) scanned`,
  );
  lines.push('');

  for (const issue of [...report.errors, ...report.warnings, ...report.info]) {
    lines.push(`  ${LABEL[issue.severity]} [${issue.category}] ${issue.code}: ${issue.message}`);
  }
  if (report.errors.length + report.warnings.length + report.info.length > 0) lines.push('');

  const verdict = report.valid ? 'VALID' : 'INVALID';
  lines.push(
    `${verdict} — ${report.errors.length} error(s), ${report.warnings.length} warning(s), ` +
      `${report.info.length} info`,
  );
  return lines.join('\n');
}
