import { XMLParser } from 'fast-xml-parser';

export class ManifestParseError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'missing_manifest'
      | 'malformed_xml'
      | 'missing_organizations'
      | 'no_scos'
      | 'unknown_version',
  ) {
    super(message);
    this.name = 'ManifestParseError';
  }
}

export type ScormVersion = 'SCORM_1_2' | 'SCORM_2004_2' | 'SCORM_2004_3' | 'SCORM_2004_4';

export interface ManifestSco {
  identifier: string;
  title: string;
  /** Relative href into the package — the SCO entry point. */
  launchHref: string;
  parameters: string | null;
  masteryScore: number | null;
}

export interface ParsedManifest {
  version: ScormVersion;
  identifier: string;
  title: string;
  description: string | null;
  keywords: string[];
  schemaVersion: string | null;
  defaultOrganizationId: string | null;
  masteryScore: number | null;
  scos: ManifestSco[];
  /** The SCO selected as the player's default entry point. */
  primarySco: ManifestSco;
  /** All `<file href>` resources referenced in the manifest, deduplicated. */
  resourceFiles: string[];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
  // Make the shape predictable — never collapse single-child arrays.
  isArray: (name) => ARRAY_PATHS.has(name),
});

const ARRAY_PATHS = new Set([
  'organization',
  'item',
  'resource',
  'file',
  'dependency',
  'keyword',
]);

/**
 * Parse `imsmanifest.xml` into the raw `<manifest>` element tree (namespace
 * prefixes stripped, attributes as `@_name`, list elements always arrays).
 * The validator walks this for checks the normalised `ParsedManifest` drops.
 */
export function parseManifestTree(xml: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = xmlParser.parse(xml);
  } catch (err) {
    throw new ManifestParseError(
      `imsmanifest.xml is not well-formed XML: ${(err as Error).message}`,
      'malformed_xml',
    );
  }

  const manifest = pick(doc, 'manifest');
  if (!isRecord(manifest)) {
    throw new ManifestParseError('imsmanifest.xml is missing a <manifest> root element', 'malformed_xml');
  }
  return manifest;
}

export function parseImsManifest(xml: string): ParsedManifest {
  const manifest = parseManifestTree(xml);

  const version = detectVersion(manifest);
  const organizations = pick(manifest, 'organizations');
  if (!isRecord(organizations)) {
    throw new ManifestParseError('imsmanifest.xml has no <organizations> element', 'missing_organizations');
  }

  const defaultOrgId = attr(organizations, 'default') ?? null;
  const orgList = asArray<Record<string, unknown>>(organizations.organization);
  const defaultOrg =
    orgList.find((o) => attr(o, 'identifier') === defaultOrgId) ?? orgList[0];
  if (!defaultOrg) {
    throw new ManifestParseError('imsmanifest.xml has no <organization>', 'missing_organizations');
  }

  const resources = pick(manifest, 'resources');
  const resourcesBase = xmlBase(resources);
  const resourceList = isRecord(resources) ? asArray<Record<string, unknown>>(resources.resource) : [];
  const resourceById = new Map<string, Record<string, unknown>>();
  for (const r of resourceList) {
    const id = attr(r, 'identifier');
    if (id) resourceById.set(id, r);
  }

  const scos: ManifestSco[] = [];
  const collectScos = (item: Record<string, unknown>) => {
    const identifierRef = attr(item, 'identifierref');
    const children = asArray<Record<string, unknown>>(item['item']);
    if (identifierRef) {
      const resource = resourceById.get(identifierRef);
      if (resource) {
        const scormType = attr(resource, 'scormtype') ?? attr(resource, 'scormType');
        const href = attr(resource, 'href');
        if (scormType?.toLowerCase() === 'sco' && href) {
          scos.push({
            identifier: attr(item, 'identifier') ?? identifierRef,
            title: textOf(item['title']) ?? identifierRef,
            launchHref: applyXmlBase(href, resourcesBase, xmlBase(resource)),
            parameters: attr(item, 'parameters') ?? null,
            masteryScore: parseMastery(item),
          });
        }
      }
    }
    for (const child of children) collectScos(child);
  };
  for (const child of asArray<Record<string, unknown>>(defaultOrg['item'])) collectScos(child);

  if (scos.length === 0) {
    throw new ManifestParseError(
      'imsmanifest.xml has no launchable SCO resources (scormType="sco" with href)',
      'no_scos',
    );
  }

  const orgTitle = textOf(defaultOrg.title);
  const lomMetadata = extractLomMetadata(pick(manifest, 'metadata'));

  const title = orgTitle ?? lomMetadata.title ?? attr(manifest, 'identifier') ?? 'Untitled Course';
  const description = lomMetadata.description ?? null;

  const resourceFiles = new Set<string>();
  for (const r of resourceList) {
    for (const f of asArray<Record<string, unknown>>(r['file'])) {
      const href = attr(f, 'href');
      if (href) resourceFiles.add(href);
    }
  }

  return {
    version,
    identifier: attr(manifest, 'identifier') ?? 'manifest',
    title,
    description,
    keywords: lomMetadata.keywords,
    schemaVersion: lomMetadata.schemaVersion,
    defaultOrganizationId: defaultOrgId,
    masteryScore: scos[0]?.masteryScore ?? null,
    scos,
    primarySco: scos[0]!,
    resourceFiles: [...resourceFiles],
  };
}

function detectVersion(manifest: Record<string, unknown>): ScormVersion {
  const metadata = pick(manifest, 'metadata');
  const schema = isRecord(metadata) ? textOf(metadata.schema)?.toLowerCase() ?? '' : '';
  const schemaversion = isRecord(metadata) ? textOf(metadata.schemaversion) ?? '' : '';

  if (schema.includes('ims content') || schemaversion.trim() === '1.2') {
    return 'SCORM_1_2';
  }
  if (schema.includes('adl scorm')) {
    const v = schemaversion.trim().toUpperCase();
    if (v.includes('CAM 1.3') || v === '2004 2ND EDITION') return 'SCORM_2004_2';
    if (v === '2004 3RD EDITION') return 'SCORM_2004_3';
    if (v === '2004 4TH EDITION') return 'SCORM_2004_4';
    // Default ADL SCORM with no clearer signal → assume 2004 4th edition.
    return 'SCORM_2004_4';
  }

  // Fall back to attribute-based detection — many 2004 packages declare it
  // via xmlns:adlcp / xmlns:imsss.
  const xmlnsAdlcp = attr(manifest, 'xmlns:adlcp') ?? attr(manifest, 'xmlnsAdlcp') ?? '';
  if (xmlnsAdlcp.includes('adlcp_v1p3') || xmlnsAdlcp.includes('rootv1p2')) {
    return xmlnsAdlcp.includes('rootv1p2') ? 'SCORM_1_2' : 'SCORM_2004_4';
  }
  if (xmlnsAdlcp.includes('adlcp_rootv1p2')) return 'SCORM_1_2';

  throw new ManifestParseError(
    `Could not detect SCORM version (schema='${schema}', schemaversion='${schemaversion}')`,
    'unknown_version',
  );
}

interface LomMetadata {
  title: string | null;
  description: string | null;
  keywords: string[];
  schemaVersion: string | null;
}

function extractLomMetadata(metadata: unknown): LomMetadata {
  const empty: LomMetadata = { title: null, description: null, keywords: [], schemaVersion: null };
  if (!isRecord(metadata)) return empty;

  const schemaVersion = textOf(metadata.schemaversion) ?? null;
  const lom = pick(metadata, 'lom');
  if (!isRecord(lom)) return { ...empty, schemaVersion };

  const general = pick(lom, 'general');
  if (!isRecord(general)) return { ...empty, schemaVersion };

  return {
    title: textOf(pick(general, 'title')) ?? textOf(pick(pick(general, 'title'), 'string')) ?? null,
    description:
      textOf(pick(general, 'description')) ??
      textOf(pick(pick(general, 'description'), 'string')) ??
      null,
    keywords: asArray(general.keyword)
      .map((k) => textOf(k) ?? textOf(pick(k, 'string')) ?? '')
      .filter(Boolean),
    schemaVersion,
  };
}

function xmlBase(node: unknown): string | undefined {
  return attr(node, 'base') ?? attr(node, 'xml:base');
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:|^\/\//i;

/**
 * Prefix a package-relative href with the `xml:base` of its <resources> and
 * <resource> elements, as the SCORM CAM allows. Absolute hrefs, and hrefs
 * under an absolute base, are returned as-is.
 */
function applyXmlBase(href: string, ...bases: Array<string | undefined>): string {
  if (ABSOLUTE.test(href)) return href;
  const relative = bases.filter((b): b is string => !!b);
  if (relative.length === 0 || relative.some((b) => ABSOLUTE.test(b))) return href;
  const prefix = relative.map(trimBase).filter(Boolean).join('/');
  return prefix ? `${prefix}/${href.replace(/^\.\//, '')}` : href;
}

/** Drop a leading `./` and trailing slashes (without a backtracking regex). */
function trimBase(base: string): string {
  let end = base.length;
  while (end > 0 && base[end - 1] === '/') end--;
  const start = base.startsWith('./') ? 2 : 0;
  return base.slice(start, Math.max(start, end));
}

function parseMastery(item: Record<string, unknown>): number | null {
  // SCORM 1.2: <adlcp:masteryscore>80</adlcp:masteryscore>
  // SCORM 2004 sequencing-based mastery is a Day 3 concern.
  const raw = textOf(item['masteryscore']) ?? textOf(item['adlcp:masteryscore']) ?? null;
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Accessors for the tree returned by `parseManifestTree`. */
export const manifestTree = {
  isRecord: (value: unknown): value is Record<string, unknown> => isRecord(value),
  pick: (value: unknown, key: string): unknown => pick(value, key),
  attr: (value: unknown, key: string): string | undefined => attr(value, key),
  textOf: (value: unknown): string | undefined => textOf(value),
  asArray: <T = unknown>(value: unknown): T[] => asArray<T>(value),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function attr(value: unknown, key: string): string | undefined {
  const v = pick(value, `@_${key}`);
  return typeof v === 'string' ? v : undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (isRecord(value)) {
    const t = value['#text'];
    if (typeof t === 'string') return t.trim() || undefined;
  }
  return undefined;
}

function asArray<T = unknown>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}
