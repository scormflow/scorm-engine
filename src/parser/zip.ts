import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import yauzl, { type Entry, type ZipFile } from 'yauzl';

import type { StorageAdapter } from '../storage/types.js';

export class ZipExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ZipExtractionError';
  }
}

export interface ExtractedFile {
  /** Path relative to the zip root, normalized with forward slashes. */
  path: string;
  sizeBytes: number;
}

export interface ZipExtractionResult {
  files: ExtractedFile[];
  totalBytes: number;
}

interface ExtractOptions {
  /** Hard cap on the uncompressed size of any single entry. Defaults to 1 GiB. */
  maxEntrySizeBytes?: number;
  /** Hard cap on total uncompressed size. Defaults to 2 GiB. */
  maxTotalSizeBytes?: number;
  /** Hard cap on file count. Defaults to 50,000. */
  maxFileCount?: number;
}

const DEFAULTS: Required<ExtractOptions> = {
  maxEntrySizeBytes: 1024 * 1024 * 1024,
  maxTotalSizeBytes: 2 * 1024 * 1024 * 1024,
  maxFileCount: 50_000,
};

/**
 * Extract a ZIP buffer to the configured storage adapter under the given prefix.
 * Streams each entry directly to storage — never holds the full archive in memory.
 *
 * The extractor enforces several anti-zipbomb invariants:
 *  - per-entry size cap
 *  - total uncompressed size cap
 *  - file-count cap
 *  - path traversal rejected (no absolute paths, no `..` segments)
 */
export async function extractZipToStorage(
  buffer: Buffer,
  storage: StorageAdapter,
  prefix: string,
  options: ExtractOptions = {},
): Promise<ZipExtractionResult> {
  const limits = { ...DEFAULTS, ...options };
  const files: ExtractedFile[] = [];
  let totalBytes = 0;

  const zipfile = await openBuffer(buffer);

  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.on('error', reject);
      zipfile.on('end', resolve);
      zipfile.on('entry', (entry: Entry) => {
        const handle = async (): Promise<void> => {
          const safePath = sanitizeEntryPath(entry.fileName);
          if (safePath === null) {
            // Directory or unsafe path — skip.
            zipfile.readEntry();
            return;
          }

          if (entry.uncompressedSize > limits.maxEntrySizeBytes) {
            throw new ZipExtractionError(
              `Entry '${safePath}' exceeds the per-entry size cap (${entry.uncompressedSize} > ${limits.maxEntrySizeBytes})`,
            );
          }
          if (files.length + 1 > limits.maxFileCount) {
            throw new ZipExtractionError(`Archive exceeds the maximum file count (${limits.maxFileCount})`);
          }
          if (totalBytes + entry.uncompressedSize > limits.maxTotalSizeBytes) {
            throw new ZipExtractionError(
              `Archive exceeds the total size cap (${totalBytes + entry.uncompressedSize} > ${limits.maxTotalSizeBytes})`,
            );
          }

          const stream = await openReadStream(zipfile, entry);
          const storageKey = joinKey(prefix, safePath);
          await storage.put(storageKey, stream);

          files.push({ path: safePath, sizeBytes: entry.uncompressedSize });
          totalBytes += entry.uncompressedSize;
          zipfile.readEntry();
        };

        handle().catch(reject);
      });

      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }

  return { files, totalBytes };
}

/**
 * Read a single named entry's contents from a ZIP buffer. Returns null if the entry is missing.
 * Caller is expected to use this for small text files like `imsmanifest.xml`.
 */
export async function readZipEntry(buffer: Buffer, entryName: string): Promise<Buffer | null> {
  const zipfile = await openBuffer(buffer);
  const target = entryName.toLowerCase();

  try {
    return await new Promise<Buffer | null>((resolve, reject) => {
      let resolved = false;
      zipfile.on('error', reject);
      zipfile.on('end', () => {
        if (!resolved) resolve(null);
      });
      zipfile.on('entry', (entry: Entry) => {
        if (entry.fileName.toLowerCase() === target) {
          openReadStream(zipfile, entry)
            .then(async (stream) => {
              const chunks: Buffer[] = [];
              for await (const chunk of stream) {
                chunks.push(chunk as Buffer);
              }
              resolved = true;
              resolve(Buffer.concat(chunks));
            })
            .catch(reject);
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }
}

export interface ZipInventoryEntry {
  /** Sanitized forward-slash path, or the raw name when `unsafe` is true. */
  path: string;
  sizeBytes: number;
  compressedBytes: number;
  /** True for absolute or `..` paths — these are never extracted. */
  unsafe: boolean;
}

export interface ZipInventory {
  entries: ZipInventoryEntry[];
  totalBytes: number;
  /** Contents of the entries selected by `readContent`, keyed by path. */
  contents: Map<string, Buffer>;
}

interface InventoryOptions {
  /** Decide per entry whether its bytes should be read into `contents`. */
  readContent?: (path: string, sizeBytes: number) => boolean;
  /** Hard cap on the total bytes read into `contents`. Defaults to 32 MiB. */
  maxContentBytes?: number;
  /** Hard cap on file count. Defaults to 50,000. */
  maxFileCount?: number;
}

/**
 * List every file entry in a ZIP buffer without writing anything, optionally
 * reading a bounded subset of entries (e.g. small HTML/JS files) into memory.
 * Used by the package validator.
 */
export async function readZipInventory(
  buffer: Buffer,
  options: InventoryOptions = {},
): Promise<ZipInventory> {
  const maxContentBytes = options.maxContentBytes ?? 32 * 1024 * 1024;
  const maxFileCount = options.maxFileCount ?? DEFAULTS.maxFileCount;
  const entries: ZipInventoryEntry[] = [];
  const contents = new Map<string, Buffer>();
  let totalBytes = 0;
  let contentBytes = 0;

  const zipfile = await openBuffer(buffer);

  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.on('error', reject);
      zipfile.on('end', resolve);
      zipfile.on('entry', (entry: Entry) => {
        const handle = async (): Promise<void> => {
          if (entry.fileName.endsWith('/')) {
            zipfile.readEntry();
            return;
          }
          if (entries.length + 1 > maxFileCount) {
            throw new ZipExtractionError(`Archive exceeds the maximum file count (${maxFileCount})`);
          }
          const safePath = sanitizeEntryPath(entry.fileName);
          const item: ZipInventoryEntry = {
            path: safePath ?? entry.fileName,
            sizeBytes: entry.uncompressedSize,
            compressedBytes: entry.compressedSize,
            unsafe: safePath === null,
          };
          entries.push(item);
          totalBytes += entry.uncompressedSize;

          if (
            safePath !== null &&
            options.readContent?.(safePath, entry.uncompressedSize) &&
            contentBytes + entry.uncompressedSize <= maxContentBytes
          ) {
            const stream = await openReadStream(zipfile, entry);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(chunk as Buffer);
            const data = Buffer.concat(chunks);
            contents.set(safePath, data);
            contentBytes += data.length;
          }
          zipfile.readEntry();
        };
        handle().catch(reject);
      });
      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }

  return { entries, totalBytes, contents };
}

/** Convenience used by tests + dev tooling — extract to a local filesystem path. */
export async function extractZipToDisk(
  buffer: Buffer,
  targetDir: string,
  options: ExtractOptions = {},
): Promise<ZipExtractionResult> {
  await mkdir(targetDir, { recursive: true });
  const limits = { ...DEFAULTS, ...options };
  const files: ExtractedFile[] = [];
  let totalBytes = 0;

  const zipfile = await openBuffer(buffer);

  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.on('error', reject);
      zipfile.on('end', resolve);
      zipfile.on('entry', (entry: Entry) => {
        const handle = async (): Promise<void> => {
          const safePath = sanitizeEntryPath(entry.fileName);
          if (safePath === null) {
            zipfile.readEntry();
            return;
          }
          if (entry.uncompressedSize > limits.maxEntrySizeBytes) {
            throw new ZipExtractionError(`Entry '${safePath}' exceeds the per-entry size cap`);
          }
          if (files.length + 1 > limits.maxFileCount) {
            throw new ZipExtractionError('Archive exceeds the maximum file count');
          }
          if (totalBytes + entry.uncompressedSize > limits.maxTotalSizeBytes) {
            throw new ZipExtractionError('Archive exceeds the total size cap');
          }
          const target = path.join(targetDir, safePath);
          await mkdir(path.dirname(target), { recursive: true });
          const stream = await openReadStream(zipfile, entry);
          await pipeline(stream, createWriteStream(target));
          files.push({ path: safePath, sizeBytes: entry.uncompressedSize });
          totalBytes += entry.uncompressedSize;
          zipfile.readEntry();
        };
        handle().catch(reject);
      });
      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }

  return { files, totalBytes };
}

function openBuffer(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(new ZipExtractionError('Failed to open ZIP archive', { cause: err }));
        return;
      }
      resolve(zipfile);
    });
  });
}

function openReadStream(zipfile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(new ZipExtractionError(`Failed to read entry '${entry.fileName}'`, { cause: err }));
        return;
      }
      resolve(stream);
    });
  });
}

/**
 * Normalize a ZIP entry's filename to a safe, forward-slash-relative path or null
 * if it's a directory or path-traversal attempt.
 */
function sanitizeEntryPath(rawFileName: string): string | null {
  if (rawFileName.endsWith('/')) return null;
  const normalized = rawFileName.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized)) return null;
  const segments = path.posix.normalize(normalized).split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '') return null;
  }
  return segments.join('/');
}

function joinKey(prefix: string, suffix: string): string {
  const left = prefix.replace(/\/+$/, '');
  const right = suffix.replace(/^\/+/, '');
  return `${left}/${right}`;
}

/** Test-only re-export. */
export const _internal = { sanitizeEntryPath, joinKey };
