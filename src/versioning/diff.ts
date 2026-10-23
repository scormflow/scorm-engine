/**
 * Diff two course releases: metadata, the SCO list (matched by manifest
 * identifier) and, when both sides carry a file inventory, the package assets
 * (matched by path, compared by SHA-256). Pure — callers load the versions.
 */

export interface VersionFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface VersionSco {
  identifier: string;
  title: string;
  launchHref: string;
  parameters: string | null;
}

/** The parts of a release the diff reads. */
export interface DiffableVersion {
  number: number;
  label: string;
  title: string;
  description: string | null;
  scormVersion: string;
  masteryScore: number | null;
  /** Launch path relative to the package root. */
  launchHref: string;
  scos: VersionSco[];
  files: VersionFile[] | null;
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ScoChange {
  identifier: string;
  changes: FieldChange[];
}

export interface AssetDiff {
  added: VersionFile[];
  removed: VersionFile[];
  modified: Array<{ path: string; fromSizeBytes: number; toSizeBytes: number }>;
  unchangedCount: number;
  /** Total size of `to` minus total size of `from`. */
  bytesDelta: number;
}

export interface VersionDiff {
  from: { number: number; label: string };
  to: { number: number; label: string };
  /** True when nothing at all differs (metadata, SCOs and — if known — assets). */
  identical: boolean;
  metadata: FieldChange[];
  scos: { added: VersionSco[]; removed: VersionSco[]; changed: ScoChange[] };
  /** Null when either release predates file inventories (a backfilled baseline). */
  assets: AssetDiff | null;
  /**
   * Changes that can strand learners mid-course if they were moved onto the
   * new release: a removed SCO, a changed SCO launch file or SCORM version.
   * Attempts stay pinned to the release they started on, so these are
   * advisory — they matter for anyone relaunching on the new release.
   */
  breakingChanges: string[];
}

const METADATA_FIELDS = ['title', 'description', 'scormVersion', 'masteryScore', 'launchHref'] as const;
const SCO_FIELDS = ['title', 'launchHref', 'parameters'] as const;

export function diffVersions(from: DiffableVersion, to: DiffableVersion): VersionDiff {
  const metadata: FieldChange[] = [];
  for (const field of METADATA_FIELDS) {
    if (from[field] !== to[field]) metadata.push({ field, from: from[field], to: to[field] });
  }

  const fromScos = new Map(from.scos.map((s) => [s.identifier, s]));
  const toScos = new Map(to.scos.map((s) => [s.identifier, s]));
  const added = to.scos.filter((s) => !fromScos.has(s.identifier));
  const removed = from.scos.filter((s) => !toScos.has(s.identifier));
  const changed: ScoChange[] = [];
  for (const before of from.scos) {
    const after = toScos.get(before.identifier);
    if (!after) continue;
    const changes = SCO_FIELDS.filter((f) => (before[f] ?? null) !== (after[f] ?? null)).map((field) => ({
      field,
      from: before[field] ?? null,
      to: after[field] ?? null,
    }));
    if (changes.length > 0) changed.push({ identifier: before.identifier, changes });
  }

  const assets = from.files && to.files ? diffFiles(from.files, to.files) : null;

  const breakingChanges: string[] = [];
  if (from.scormVersion !== to.scormVersion) {
    breakingChanges.push(`SCORM version changed from ${from.scormVersion} to ${to.scormVersion}`);
  }
  for (const sco of removed) breakingChanges.push(`SCO "${sco.identifier}" was removed`);
  for (const sco of changed) {
    if (sco.changes.some((c) => c.field === 'launchHref')) {
      breakingChanges.push(`SCO "${sco.identifier}" launches a different file`);
    }
  }

  const assetsChanged =
    assets !== null && (assets.added.length > 0 || assets.removed.length > 0 || assets.modified.length > 0);

  return {
    from: { number: from.number, label: from.label },
    to: { number: to.number, label: to.label },
    identical:
      metadata.length === 0 &&
      added.length === 0 &&
      removed.length === 0 &&
      changed.length === 0 &&
      assets !== null &&
      !assetsChanged,
    metadata,
    scos: { added, removed, changed },
    assets,
    breakingChanges,
  };
}

function diffFiles(from: VersionFile[], to: VersionFile[]): AssetDiff {
  const before = new Map(from.map((f) => [f.path, f]));
  const after = new Map(to.map((f) => [f.path, f]));
  const added = to.filter((f) => !before.has(f.path));
  const removed = from.filter((f) => !after.has(f.path));
  const modified: AssetDiff['modified'] = [];
  let unchangedCount = 0;
  for (const file of from) {
    const next = after.get(file.path);
    if (!next) continue;
    if (next.sha256 === file.sha256) unchangedCount += 1;
    else modified.push({ path: file.path, fromSizeBytes: file.sizeBytes, toSizeBytes: next.sizeBytes });
  }
  const total = (files: VersionFile[]) => files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    added: added.sort(byPath),
    removed: removed.sort(byPath),
    modified: modified.sort(byPath),
    unchangedCount,
    bytesDelta: total(to) - total(from),
  };
}
