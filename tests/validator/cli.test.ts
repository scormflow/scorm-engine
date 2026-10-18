import { describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../../src/cli.js';
import { buildScormZip } from '../helpers/scorm-fixture.js';
import { buildCmi5Zip } from '../helpers/cmi5-fixture.js';

function harness(files: Record<string, Buffer>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readFile: async (p) => {
      const f = files[p];
      if (!f) throw new Error('ENOENT: no such file');
      return f;
    },
  };
  return { io, out, err };
}

const HTML = '<html lang="en"><head><title>x</title><script>API.LMSInitialize("")</script></head></html>';

describe('scormflow CLI', () => {
  it('prints a readable report and exits 0 for a valid package', async () => {
    const { io, out } = harness({ 'ok.zip': buildScormZip({ extraFiles: [{ path: 'index.html', content: HTML }] }) });
    const code = await runCli(['validate', 'ok.zip'], io);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('ok.zip: SCORM 1.2 — "Test Course"');
    expect(out.join('\n')).toContain('VALID — 0 error(s)');
  });

  it('exits 1 for an invalid package', async () => {
    const { io, out } = harness({ 'bad.zip': Buffer.from('nope') });
    expect(await runCli(['validate', 'bad.zip'], io)).toBe(1);
    expect(out.join('\n')).toContain('ERROR [structure] malformed_zip');
  });

  it('--strict fails on warnings', async () => {
    const html = '<html><head><title>x</title><script>API.LMSInitialize("")</script></head></html>';
    const files = { 'warn.zip': buildScormZip({ extraFiles: [{ path: 'index.html', content: html }] }) };
    expect(await runCli(['validate', 'warn.zip'], harness(files).io)).toBe(0);
    expect(await runCli(['validate', 'warn.zip', '--strict'], harness(files).io)).toBe(1);
  });

  it('--json prints the report, and an array for several files', async () => {
    const files = { 'a.zip': buildScormZip(), 'b.zip': buildCmi5Zip() };
    const one = harness(files);
    await runCli(['validate', 'a.zip', '--json'], one.io);
    expect(JSON.parse(one.out.join(''))).toMatchObject({ file: 'a.zip', valid: true, packageType: 'scorm' });

    const many = harness(files);
    await runCli(['validate', '--json', 'a.zip', 'b.zip'], many.io);
    const reports = JSON.parse(many.out.join(''));
    expect(reports.map((r: { packageType: string }) => r.packageType)).toEqual(['scorm', 'cmi5']);
  });

  it('exits 2 on usage and I/O errors', async () => {
    expect(await runCli([], harness({}).io)).toBe(2);
    expect(await runCli(['frobnicate'], harness({}).io)).toBe(2);
    expect(await runCli(['validate'], harness({}).io)).toBe(2);
    expect(await runCli(['validate', 'x.zip', '--fast'], harness({}).io)).toBe(2);
    const missing = harness({});
    expect(await runCli(['validate', 'missing.zip'], missing.io)).toBe(2);
    expect(missing.err.join('')).toContain('Cannot read missing.zip');
  });

  it('prints help and version', async () => {
    const h = harness({});
    expect(await runCli(['--help'], h.io)).toBe(0);
    expect(h.out.join('')).toContain('Usage: scormflow validate');
    const v = harness({});
    expect(await runCli(['--version'], v.io)).toBe(0);
    expect(v.out[0]).toMatch(/^\d+\.\d+\.\d+/);
  });
});
