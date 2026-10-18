import path from 'node:path';

import { manifestTree as t, type ParsedManifest, type ScormVersion } from '../parser/manifest.js';
import type { ZipInventoryEntry } from '../parser/zip.js';
import type { IssueCollector } from './collector.js';

/**
 * Individual validator checks. Everything here is pure — it works off the ZIP
 * inventory, the parsed manifest tree and the scanned file contents.
 *
 * Content scanning deliberately avoids backtracking regexes over untrusted
 * markup: tags are located with `indexOf`, and the one regex used has a
 * bounded quantifier.
 */

export const HTML_EXT = new Set(['.html', '.htm', '.xhtml']);
export const SCANNED_EXT = new Set([...HTML_EXT, '.js']);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const RAW_IMAGE_EXT = new Set(['.bmp', '.tif', '.tiff']);
const PLUGIN_EXT: Record<string, string> = {
  '.swf': 'Adobe Flash',
  '.dcr': 'Adobe Shockwave',
  '.xap': 'Microsoft Silverlight',
  '.jar': 'Java applet',
};
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

export class FileIndex {
  private readonly exact = new Set<string>();
  private readonly lower = new Map<string, string>();

  constructor(entries: ZipInventoryEntry[]) {
    for (const e of entries) {
      if (e.unsafe) continue;
      this.exact.add(e.path);
      this.lower.set(e.path.toLowerCase(), e.path);
    }
  }

  has(p: string): boolean {
    return this.exact.has(p);
  }

  /** The actual path when `p` only exists with different letter case. */
  caseVariant(p: string): string | null {
    return this.lower.get(p.toLowerCase()) ?? null;
  }
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Turn a manifest href into a package path: strip query/fragment, decode
 * percent-escapes and resolve against any `xml:base`. Returns null for
 * absolute URLs, which point outside the package.
 */
export function resolveHref(href: string, ...bases: Array<string | undefined>): string | null {
  if (URL_SCHEME.test(href) || href.startsWith('//')) return null;
  let p = href.split(/[?#]/, 1)[0] ?? '';
  try {
    p = decodeURIComponent(p);
  } catch {
    // Keep the raw path; a bad escape is reported as a missing file.
  }
  const base = bases.filter((b): b is string => !!b && !URL_SCHEME.test(b)).join('/');
  const joined = path.posix.normalize(path.posix.join(base, p.replace(/\\/g, '/')));
  return joined.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

function xmlBase(node: unknown): string | undefined {
  return t.attr(node, 'base') ?? t.attr(node, 'xml:base');
}

/** Structure-level checks on the raw entry list. */
export function checkEntries(entries: ZipInventoryEntry[], issues: IssueCollector): void {
  for (const e of entries) {
    if (e.unsafe) {
      issues.error(
        'structure',
        'unsafe_path',
        `Entry '${e.path}' uses an absolute or '..' path and will not be extracted`,
        e.path,
      );
      continue;
    }
    const base = path.posix.basename(e.path).toLowerCase();
    if (e.path.startsWith('__MACOSX/') || JUNK_NAMES.has(base)) {
      issues.info('structure', 'junk_file', `'${e.path}' is an OS metadata file and can be removed`, e.path);
    }
  }
}

export function findNestedManifest(entries: ZipInventoryEntry[], name: string): string | null {
  const target = `/${name}`;
  const nested = entries
    .filter((e) => !e.unsafe && e.path.toLowerCase().endsWith(target))
    .sort((a, b) => a.path.length - b.path.length)[0];
  return nested?.path ?? null;
}

/** Identifier integrity, references and launch/resource files in `imsmanifest.xml`. */
export function checkManifest(
  tree: Record<string, unknown>,
  manifest: ParsedManifest,
  files: FileIndex,
  issues: IssueCollector,
): void {
  const seen = new Map<string, string>();
  const claim = (id: string | undefined, kind: string) => {
    if (!id) return;
    const previous = seen.get(id);
    if (previous) {
      issues.error(
        'manifest',
        'duplicate_identifier',
        `Identifier '${id}' is used by both a ${previous} and a ${kind}; identifiers must be unique`,
      );
    } else {
      seen.set(id, kind);
    }
  };

  claim(t.attr(tree, 'identifier'), 'manifest');

  const resources = t.pick(tree, 'resources');
  const resourceList = t.asArray<Record<string, unknown>>(t.pick(resources, 'resource'));
  const resourceIds = new Set<string>();
  for (const r of resourceList) {
    const id = t.attr(r, 'identifier');
    claim(id, 'resource');
    if (id) resourceIds.add(id);
  }

  const organizations = t.pick(tree, 'organizations');
  const orgList = t.asArray<Record<string, unknown>>(t.pick(organizations, 'organization'));
  const defaultOrg = t.attr(organizations, 'default');
  if (defaultOrg && !orgList.some((o) => t.attr(o, 'identifier') === defaultOrg)) {
    issues.warn(
      'manifest',
      'default_organization_missing',
      `<organizations default="${defaultOrg}"> does not match any <organization>; the first one is used`,
    );
  }

  const walkItems = (items: Record<string, unknown>[]) => {
    for (const item of items) {
      const id = t.attr(item, 'identifier');
      claim(id, 'item');
      const ref = t.attr(item, 'identifierref');
      if (ref && !resourceIds.has(ref)) {
        issues.error(
          'manifest',
          'broken_identifierref',
          `Item '${id ?? '?'}' references resource '${ref}', which is not declared in <resources>`,
        );
      }
      walkItems(t.asArray<Record<string, unknown>>(item['item']));
    }
  };
  for (const org of orgList) {
    claim(t.attr(org, 'identifier'), 'organization');
    if (!t.textOf(org['title'])) {
      issues.info('manifest', 'missing_title', `Organization '${t.attr(org, 'identifier') ?? '?'}' has no <title>`);
    }
    walkItems(t.asArray<Record<string, unknown>>(org['item']));
  }

  const resourcesBase = xmlBase(resources);
  for (const r of resourceList) {
    const id = t.attr(r, 'identifier') ?? '?';
    const scormType = (t.attr(r, 'scormtype') ?? t.attr(r, 'scormType') ?? '').toLowerCase();
    const href = t.attr(r, 'href');
    const base = xmlBase(r);

    for (const dep of t.asArray(t.pick(r, 'dependency'))) {
      const ref = t.attr(dep, 'identifierref');
      if (ref && !resourceIds.has(ref)) {
        issues.warn(
          'manifest',
          'broken_dependency',
          `Resource '${id}' depends on '${ref}', which is not declared in <resources>`,
        );
      }
    }

    if (scormType === 'sco' && !href) {
      issues.warn('manifest', 'sco_without_href', `SCO resource '${id}' has no href and cannot be launched`);
    }

    if (href) {
      const resolved = resolveHref(href, resourcesBase, base);
      if (resolved === null) {
        issues.info(
          'resources',
          'external_launch_url',
          `Resource '${id}' launches an external URL (${href}); it is not checked`,
        );
      } else {
        checkFile(resolved, files, issues, scormType === 'sco' ? 'launch' : 'resource', id);
      }
    }

    for (const f of t.asArray(t.pick(r, 'file'))) {
      const fileHref = t.attr(f, 'href');
      if (!fileHref) continue;
      const resolved = resolveHref(fileHref, resourcesBase, base);
      if (resolved !== null && resolved !== (href ? resolveHref(href, resourcesBase, base) : null)) {
        checkFile(resolved, files, issues, 'resource', id);
      }
    }
  }

  if (manifest.version === 'SCORM_1_2') {
    for (const sco of manifest.scos) {
      if (sco.masteryScore !== null && (sco.masteryScore < 0 || sco.masteryScore > 100)) {
        issues.warn(
          'manifest',
          'mastery_score_out_of_range',
          `SCO '${sco.identifier}' has masteryscore ${sco.masteryScore}; SCORM 1.2 expects 0–100`,
        );
      }
    }
  }
}

function checkFile(
  resolved: string,
  files: FileIndex,
  issues: IssueCollector,
  kind: 'launch' | 'resource',
  resourceId: string,
): void {
  if (files.has(resolved)) return;
  const variant = files.caseVariant(resolved);
  if (variant) {
    issues.warn(
      'resources',
      'path_case_mismatch',
      `Resource '${resourceId}' references '${resolved}' but the package contains '${variant}'; ` +
        'this works on Windows but breaks on Linux and S3-backed storage',
      resolved,
    );
    return;
  }
  if (kind === 'launch') {
    issues.error(
      'resources',
      'missing_launch_file',
      `Launch file '${resolved}' for SCO resource '${resourceId}' is not in the package`,
      resolved,
    );
  } else {
    issues.warn(
      'resources',
      'missing_resource_file',
      `File '${resolved}' listed by resource '${resourceId}' is not in the package`,
      resolved,
    );
  }
}

/** Size and format checks over every entry. */
export function checkAssets(
  entries: ZipInventoryEntry[],
  totalBytes: number,
  limits: { largeAssetBytes: number; largePackageBytes: number; largeImageBytes: number },
  issues: IssueCollector,
): void {
  if (totalBytes > limits.largePackageBytes) {
    issues.warn(
      'assets',
      'large_package',
      `Package unpacks to ${formatBytes(totalBytes)} (over ${formatBytes(limits.largePackageBytes)}); ` +
        'large packages are slow to upload and launch',
    );
  }
  for (const e of entries) {
    if (e.unsafe) continue;
    const ext = path.posix.extname(e.path).toLowerCase();
    const plugin = PLUGIN_EXT[ext];
    if (plugin) {
      issues.warn(
        'assets',
        'deprecated_plugin_content',
        `'${e.path}' is ${plugin} content, which no current browser can run`,
        e.path,
      );
    }
    if (e.sizeBytes > limits.largeAssetBytes) {
      issues.warn(
        'assets',
        'large_asset',
        `'${e.path}' is ${formatBytes(e.sizeBytes)}; consider compressing or streaming it`,
        e.path,
      );
    } else if (IMAGE_EXT.has(ext) && e.sizeBytes > limits.largeImageBytes) {
      issues.info(
        'assets',
        'unoptimized_image',
        `Image '${e.path}' is ${formatBytes(e.sizeBytes)}; it can likely be resized or recompressed`,
        e.path,
      );
    }
    if (RAW_IMAGE_EXT.has(ext)) {
      issues.info(
        'assets',
        'uncompressed_image_format',
        `'${e.path}' uses an uncompressed image format; convert it to PNG, JPEG or WebP`,
        e.path,
      );
    }
  }
}

// ── Runtime API + CMI data model ──────────────────────────────────────────

const ELEMENTS_12_ONLY_PREFIX = ['cmi.core.', 'cmi.student_data.', 'cmi.student_preference.'];
const ELEMENTS_12_ONLY_EXACT = new Set(['cmi.comments', 'cmi.launch_data_12']);
const ELEMENTS_2004_ONLY_PREFIX = ['cmi.score.', 'cmi.learner_preference.'];
const ELEMENTS_2004_ONLY_EXACT = new Set([
  'cmi.completion_status',
  'cmi.success_status',
  'cmi.location',
  'cmi.learner_id',
  'cmi.learner_name',
  'cmi.session_time',
  'cmi.total_time',
  'cmi.exit',
  'cmi.entry',
  'cmi.mode',
  'cmi.credit',
  'cmi.progress_measure',
  'cmi.scaled_passing_score',
  'cmi.completion_threshold',
  'cmi.comments_from_learner',
]);

// Bounded quantifier keeps this linear on hostile input.
const CMI_ELEMENT = /\bcmi\.[a-z_.0-9]{1,80}/g;

function classifyElement(raw: string): '12' | '2004' | null {
  const el = raw.replace(/\.+$/, '');
  if (ELEMENTS_12_ONLY_EXACT.has(el) || ELEMENTS_12_ONLY_PREFIX.some((p) => el.startsWith(p))) return '12';
  if (ELEMENTS_2004_ONLY_EXACT.has(el) || ELEMENTS_2004_ONLY_PREFIX.some((p) => el.startsWith(p))) return '2004';
  return null;
}

export interface RuntimeScan {
  uses12Api: boolean;
  uses2004Api: boolean;
}

/**
 * Scan one HTML/JS file for SCORM runtime usage. A file that only uses data
 * model elements from the other SCORM version gets a mismatch warning; files
 * mentioning both (version-agnostic wrappers such as pipwerks) are fine.
 */
export function scanRuntime(
  filePath: string,
  text: string,
  version: ScormVersion,
  issues: IssueCollector,
): RuntimeScan {
  const scan = {
    uses12Api: text.includes('LMSInitialize') || text.includes('LMSSetValue') || text.includes('LMSGetValue'),
    uses2004Api: text.includes('API_1484_11'),
  };

  const is12 = version === 'SCORM_1_2';
  const wrong = new Set<string>();
  let right = 0;
  for (const match of text.matchAll(CMI_ELEMENT)) {
    const kind = classifyElement(match[0]);
    if (kind === null) continue;
    if ((kind === '12') === is12) right++;
    else wrong.add(match[0].replace(/\.+$/, ''));
  }
  if (wrong.size > 0 && right === 0) {
    const sample = [...wrong].slice(0, 5).join(', ');
    issues.warn(
      'runtime',
      'cmi_element_version_mismatch',
      `'${filePath}' uses ${is12 ? 'SCORM 2004' : 'SCORM 1.2'} data model elements (${sample}) ` +
        `in a ${is12 ? 'SCORM 1.2' : 'SCORM 2004'} package; those calls will fail at runtime`,
      filePath,
    );
  }
  return scan;
}

export function checkRuntimeApi(
  version: ScormVersion,
  scans: RuntimeScan[],
  issues: IssueCollector,
): void {
  if (scans.length === 0) return;
  const uses12 = scans.some((s) => s.uses12Api);
  const uses2004 = scans.some((s) => s.uses2004Api);
  const is12 = version === 'SCORM_1_2';

  if (!uses12 && !uses2004) {
    issues.info(
      'runtime',
      'no_runtime_api_reference',
      'No scanned HTML/JS file references the SCORM runtime API (LMSInitialize / API_1484_11); ' +
        'the course may not report progress',
    );
  } else if (is12 && !uses12) {
    issues.warn(
      'runtime',
      'runtime_api_mismatch',
      'The manifest declares SCORM 1.2 but the content only looks for the SCORM 2004 API (API_1484_11)',
    );
  } else if (!is12 && !uses2004) {
    issues.warn(
      'runtime',
      'runtime_api_mismatch',
      'The manifest declares SCORM 2004 but the content only uses the SCORM 1.2 API (LMSInitialize)',
    );
  }
}

// ── Accessibility ─────────────────────────────────────────────────────────

/** Attribute text of every `<name ...>` start tag, found without regex backtracking. */
export function findTags(lowerHtml: string, name: string): string[] {
  const out: string[] = [];
  const open = `<${name}`;
  let i = lowerHtml.indexOf(open);
  while (i !== -1) {
    const after = lowerHtml.charCodeAt(i + open.length);
    // Require a tag boundary so `<imgx` or `<html5` don't match.
    const boundary = Number.isNaN(after) || after === 62 /* > */ || after === 47 /* / */ || after <= 32;
    const end = lowerHtml.indexOf('>', i);
    if (end === -1) break;
    if (boundary) out.push(lowerHtml.slice(i + open.length, end));
    i = lowerHtml.indexOf(open, end);
  }
  return out;
}

function hasAttr(attrs: string, name: string): boolean {
  let i = attrs.indexOf(name);
  while (i !== -1) {
    const before = i === 0 ? 32 : attrs.charCodeAt(i - 1);
    let j = i + name.length;
    while (attrs.charCodeAt(j) <= 32) j++;
    if (before <= 32 && attrs.charCodeAt(j) === 61 /* = */) return true;
    i = attrs.indexOf(name, i + 1);
  }
  return false;
}

export function checkAccessibility(filePath: string, html: string, issues: IssueCollector): void {
  const lower = html.toLowerCase();
  const htmlTags = findTags(lower, 'html');
  const isDocument = htmlTags.length > 0 || lower.includes('<head');

  if (htmlTags.length > 0 && !hasAttr(htmlTags[0]!, 'lang')) {
    issues.warn(
      'accessibility',
      'a11y_missing_lang',
      `'${filePath}' has no lang attribute on <html>; screen readers cannot pick a language`,
      filePath,
    );
  }

  const missingAlt = findTags(lower, 'img').filter((attrs) => !hasAttr(attrs, 'alt')).length;
  if (missingAlt > 0) {
    issues.warn(
      'accessibility',
      'a11y_img_missing_alt',
      `'${filePath}' has ${missingAlt} <img> element(s) without alt text`,
      filePath,
    );
  }

  if (isDocument) {
    let titleText = '';
    if (findTags(lower, 'title').length > 0) {
      const open = lower.indexOf('<title');
      const start = lower.indexOf('>', open) + 1;
      const close = lower.indexOf('</title', start);
      if (close !== -1) titleText = lower.slice(start, close).trim();
    }
    if (!titleText) {
      issues.info('accessibility', 'a11y_missing_title', `'${filePath}' has no <title>`, filePath);
    }
  }
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}
