#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

import { formatReport, validateScormPackage } from './validator/index.js';
import { ENGINE_VERSION } from './version.js';

/**
 * `scormflow` command-line entry point. Kept free of database / env imports so
 * it runs anywhere Node does, e.g. in a course author's CI pipeline:
 *
 *   npx @scormflow/server validate course.zip --strict
 */

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Promise<Buffer>;
}

const USAGE = `Usage: scormflow validate <package.zip>... [--json] [--strict]

Validate SCORM 1.2 / 2004 and cmi5 packages without uploading them.

Options:
  --json     Print the full report as JSON (an array when several files are given)
  --strict   Exit non-zero on warnings as well as errors
  -h, --help Show this help
  -v, --version Show the version

Exit codes: 0 valid, 1 invalid, 2 usage or I/O error`;

/** Run the CLI and resolve with the process exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '-v' || command === '--version') {
    io.stdout(ENGINE_VERSION);
    return 0;
  }
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    io.stdout(USAGE);
    return command ? 0 : 2;
  }
  if (command !== 'validate') {
    io.stderr(`Unknown command '${command}'.\n\n${USAGE}`);
    return 2;
  }

  const flags = new Set(rest.filter((a) => a.startsWith('-')));
  const paths = rest.filter((a) => !a.startsWith('-'));
  const unknown = [...flags].filter((f) => !['--json', '--strict'].includes(f));
  if (unknown.length > 0 || paths.length === 0) {
    io.stderr(`${unknown.length > 0 ? `Unknown option ${unknown[0]}.` : 'No package given.'}\n\n${USAGE}`);
    return 2;
  }
  const json = flags.has('--json');
  const strict = flags.has('--strict');

  const reports = [];
  let failed = false;
  for (const p of paths) {
    let buffer: Buffer;
    try {
      buffer = await io.readFile(p);
    } catch (err) {
      io.stderr(`Cannot read ${p}: ${(err as Error).message}`);
      return 2;
    }
    const report = await validateScormPackage(buffer, { accept: 'any' });
    if (!report.valid || (strict && report.warnings.length > 0)) failed = true;
    reports.push({ file: p, ...report });
    if (!json) io.stdout(formatReport(report, p) + (paths.length > 1 ? '\n' : ''));
  }

  if (json) io.stdout(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  return failed ? 1 : 0;
}

function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text + '\n'),
    stderr: (text) => process.stderr.write(text + '\n'),
    readFile: (p) => readFile(p),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`scormflow: ${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
