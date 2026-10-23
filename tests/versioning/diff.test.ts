import { describe, expect, it } from 'vitest';

import { diffVersions, type DiffableVersion } from '../../src/versioning/diff.js';
import { nextLabel } from '../../src/versioning/service.js';

const base: DiffableVersion = {
  number: 1,
  label: '1.0',
  title: 'Safety',
  description: null,
  scormVersion: 'SCORM_1_2',
  masteryScore: 75,
  launchHref: 'index.html',
  scos: [
    { identifier: 'A', title: 'Intro', launchHref: 'a.html', parameters: null },
    { identifier: 'B', title: 'Quiz', launchHref: 'b.html', parameters: null },
  ],
  files: [
    { path: 'index.html', sizeBytes: 10, sha256: 'h1' },
    { path: 'a.html', sizeBytes: 20, sha256: 'h2' },
    { path: 'old.png', sizeBytes: 100, sha256: 'h3' },
  ],
};

describe('diffVersions', () => {
  it('reports identical releases as identical', () => {
    const diff = diffVersions(base, { ...base, number: 2, label: '1.1' });
    expect(diff.identical).toBe(true);
    expect(diff.metadata).toEqual([]);
    expect(diff.assets).toMatchObject({ added: [], removed: [], modified: [], unchangedCount: 3, bytesDelta: 0 });
    expect(diff.breakingChanges).toEqual([]);
  });

  it('diffs metadata, SCOs (by identifier) and assets (by hash)', () => {
    const next: DiffableVersion = {
      ...base,
      number: 2,
      label: '2.0',
      title: 'Safety v2',
      masteryScore: 80,
      scos: [
        { identifier: 'A', title: 'Introduction', launchHref: 'a2.html', parameters: null },
        { identifier: 'C', title: 'Wrap-up', launchHref: 'c.html', parameters: null },
      ],
      files: [
        { path: 'index.html', sizeBytes: 10, sha256: 'h1' },
        { path: 'a.html', sizeBytes: 25, sha256: 'h2-new' },
        { path: 'new.png', sizeBytes: 40, sha256: 'h4' },
      ],
    };
    const diff = diffVersions(base, next);
    expect(diff.identical).toBe(false);
    expect(diff.from).toEqual({ number: 1, label: '1.0' });
    expect(diff.to).toEqual({ number: 2, label: '2.0' });
    expect(diff.metadata).toEqual([
      { field: 'title', from: 'Safety', to: 'Safety v2' },
      { field: 'masteryScore', from: 75, to: 80 },
    ]);
    expect(diff.scos.added.map((s) => s.identifier)).toEqual(['C']);
    expect(diff.scos.removed.map((s) => s.identifier)).toEqual(['B']);
    expect(diff.scos.changed).toEqual([
      {
        identifier: 'A',
        changes: [
          { field: 'title', from: 'Intro', to: 'Introduction' },
          { field: 'launchHref', from: 'a.html', to: 'a2.html' },
        ],
      },
    ]);
    expect(diff.assets).toEqual({
      added: [{ path: 'new.png', sizeBytes: 40, sha256: 'h4' }],
      removed: [{ path: 'old.png', sizeBytes: 100, sha256: 'h3' }],
      modified: [{ path: 'a.html', fromSizeBytes: 20, toSizeBytes: 25 }],
      unchangedCount: 1,
      bytesDelta: -55,
    });
    expect(diff.breakingChanges).toEqual(['SCO "B" was removed', 'SCO "A" launches a different file']);
  });

  it('leaves assets null (and never claims identical) when a side has no inventory', () => {
    const diff = diffVersions({ ...base, files: null }, { ...base, number: 2, label: '1.1' });
    expect(diff.assets).toBeNull();
    expect(diff.identical).toBe(false);
  });

  it('flags a SCORM edition change as breaking', () => {
    const diff = diffVersions(base, { ...base, number: 2, label: '2.0', scormVersion: 'SCORM_2004_4' });
    expect(diff.breakingChanges).toEqual(['SCORM version changed from SCORM_1_2 to SCORM_2004_4']);
  });
});

describe('nextLabel', () => {
  it('bumps X.Y labels, keeping a v prefix', () => {
    expect(nextLabel('1.0', 2)).toBe('1.1');
    expect(nextLabel('1.9', 2)).toBe('1.10');
    expect(nextLabel('1.3', 4, 'major')).toBe('2.0');
    expect(nextLabel('v2.4', 5)).toBe('v2.5');
  });

  it('falls back to <number>.0 for free-form labels', () => {
    expect(nextLabel('spring-release', 3)).toBe('3.0');
    expect(nextLabel(null, 1)).toBe('1.0');
  });
});
