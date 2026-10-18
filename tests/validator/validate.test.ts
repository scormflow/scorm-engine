import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';

import { validateScormPackage } from '../../src/validator/index.js';
import { findTags, resolveHref } from '../../src/validator/checks.js';
import { buildScormZip } from '../helpers/scorm-fixture.js';
import { buildCmi5Zip } from '../helpers/cmi5-fixture.js';

const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

const GOOD_HTML_12 = `<!doctype html><html lang="en"><head><title>Lesson</title>
<script>var api = window.parent.API; api.LMSInitialize(''); api.LMSSetValue('cmi.core.lesson_status', 'completed');</script>
</head><body><img src="a.png" alt="Logo"></body></html>`;

const GOOD_HTML_2004 = `<!doctype html><html lang="en"><head><title>Lesson</title>
<script>var api = window.parent.API_1484_11; api.Initialize(''); api.SetValue('cmi.completion_status', 'completed');</script>
</head><body></body></html>`;

function manifest12(resources: string, items = '<item identifier="ITEM-1" identifierref="RES-1"><title>M1</title></item>'): string {
  return `<?xml version="1.0"?>
<manifest identifier="MAN-1" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG">
    <organization identifier="ORG"><title>Course</title>${items}</organization>
  </organizations>
  <resources>${resources}</resources>
</manifest>`;
}

function zipOf(files: Record<string, string | Buffer>): Buffer {
  const z = new AdmZip();
  for (const [p, content] of Object.entries(files)) {
    z.addFile(p, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }
  return z.toBuffer();
}

describe('validateScormPackage — structure', () => {
  it('passes a clean SCORM 1.2 package with no issues', async () => {
    const report = await validateScormPackage(
      buildScormZip({ extraFiles: [{ path: 'index.html', content: GOOD_HTML_12 }] }),
    );
    expect(report.valid).toBe(true);
    expect(report.packageType).toBe('scorm');
    expect(report.version).toBe('SCORM_1_2');
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.stats.launchableCount).toBe(1);
    expect(report.stats.scannedFiles).toBe(1);
  });

  it('reports malformed_zip for bytes that are not a ZIP', async () => {
    const report = await validateScormPackage(Buffer.from('definitely not a zip'));
    expect(report.valid).toBe(false);
    expect(codes(report.errors)).toEqual(['malformed_zip']);
  });

  it('spots a manifest zipped inside its folder', async () => {
    const report = await validateScormPackage(
      zipOf({ 'my-course/imsmanifest.xml': manifest12(''), 'my-course/index.html': 'x' }),
    );
    expect(report.valid).toBe(false);
    expect(report.errors[0]).toMatchObject({ code: 'manifest_not_at_root', path: 'my-course/imsmanifest.xml' });
  });

  it('reports missing_manifest when there is no manifest at all', async () => {
    const report = await validateScormPackage(zipOf({ 'index.html': 'x' }));
    expect(codes(report.errors)).toEqual(['missing_manifest']);
  });

  it('flags OS junk files as info', async () => {
    const report = await validateScormPackage(
      buildScormZip({
        extraFiles: [
          { path: 'index.html', content: GOOD_HTML_12 },
          { path: '__MACOSX/._index.html', content: 'x' },
          { path: 'img/.DS_Store', content: 'x' },
        ],
      }),
    );
    expect(report.valid).toBe(true);
    expect(codes(report.info).filter((c) => c === 'junk_file')).toHaveLength(2);
  });

  it('keeps the old parse error codes for broken manifests', async () => {
    const report = await validateScormPackage(zipOf({ 'imsmanifest.xml': '<not-xml' }));
    expect(codes(report.errors)).toEqual(['malformed_manifest']);
  });

  it('rejects a cmi5 package in scorm mode and validates it in any mode', async () => {
    const zip = buildCmi5Zip();
    const scorm = await validateScormPackage(zip);
    expect(scorm.valid).toBe(false);
    expect(scorm.errors[0]?.message).toContain('cmi5');

    const any = await validateScormPackage(zip, { accept: 'any' });
    expect(any.packageType).toBe('cmi5');
    expect(any.cmi5Structure).not.toBeNull();
    expect(any.stats.launchableCount).toBeGreaterThan(0);
  });
});

describe('validateScormPackage — manifest + resources', () => {
  it('reports a missing launch file as an error', async () => {
    const report = await validateScormPackage(
      zipOf({
        'imsmanifest.xml': manifest12(
          '<resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="lesson/start.html"/>',
        ),
      }),
    );
    expect(report.valid).toBe(false);
    expect(report.errors[0]).toMatchObject({ code: 'missing_launch_file', path: 'lesson/start.html' });
  });

  it('downgrades a case-only mismatch to a warning', async () => {
    const report = await validateScormPackage(
      zipOf({
        'imsmanifest.xml': manifest12(
          '<resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="Index.html"/>',
        ),
        'index.html': GOOD_HTML_12,
      }),
    );
    expect(report.valid).toBe(true);
    expect(codes(report.warnings)).toContain('path_case_mismatch');
  });

  it('resolves query strings, percent-escapes and xml:base on launch hrefs', async () => {
    const report = await validateScormPackage(
      zipOf({
        'imsmanifest.xml': manifest12(
          '<resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" xml:base="content/" href="my%20lesson.html?x=1#top">' +
            '<file href="my%20lesson.html"/></resource>',
        ),
        'content/my lesson.html': GOOD_HTML_12,
      }),
    );
    expect(report.errors).toEqual([]);
    expect(codes(report.warnings)).not.toContain('missing_resource_file');
  });

  it('warns on missing <file> entries and broken dependencies', async () => {
    const report = await validateScormPackage(
      zipOf({
        'imsmanifest.xml': manifest12(
          '<resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="index.html">' +
            '<file href="index.html"/><file href="media/video.mp4"/><dependency identifierref="SHARED"/></resource>',
        ),
        'index.html': GOOD_HTML_12,
      }),
    );
    expect(report.valid).toBe(true);
    expect(codes(report.warnings)).toEqual(expect.arrayContaining(['missing_resource_file', 'broken_dependency']));
  });

  it('errors on duplicate identifiers and dangling identifierrefs', async () => {
    const report = await validateScormPackage(
      zipOf({
        'imsmanifest.xml': manifest12(
          '<resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="index.html"/>',
          '<item identifier="ITEM-1" identifierref="RES-1"><title>A</title></item>' +
            '<item identifier="ITEM-1" identifierref="RES-404"><title>B</title></item>',
        ),
        'index.html': GOOD_HTML_12,
      }),
    );
    expect(codes(report.errors)).toEqual(expect.arrayContaining(['duplicate_identifier', 'broken_identifierref']));
  });

  it('notes external launch URLs without failing', async () => {
    const report = await validateScormPackage(
      zipOf({
        'imsmanifest.xml': manifest12(
          '<resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="https://cdn.example.com/c/index.html"/>',
        ),
      }),
    );
    expect(report.valid).toBe(true);
    expect(codes(report.info)).toContain('external_launch_url');
  });

  it('caps repeated issues and summarises the overflow', async () => {
    const files = Array.from({ length: 30 }, (_, i) => `<file href="missing-${i}.js"/>`).join('');
    const report = await validateScormPackage(
      zipOf({
        'imsmanifest.xml': manifest12(
          `<resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="index.html">${files}</resource>`,
        ),
        'index.html': GOOD_HTML_12,
      }),
      { maxIssuesPerCode: 10 },
    );
    const missing = report.warnings.filter((w) => w.code === 'missing_resource_file');
    expect(missing).toHaveLength(11);
    expect(missing.at(-1)?.message).toContain('20 more');
  });
});

describe('validateScormPackage — runtime compatibility', () => {
  it('warns when a 1.2 package only talks to the 2004 API', async () => {
    const report = await validateScormPackage(
      buildScormZip({ extraFiles: [{ path: 'index.html', content: GOOD_HTML_2004 }] }),
    );
    expect(codes(report.warnings)).toEqual(
      expect.arrayContaining(['runtime_api_mismatch', 'cmi_element_version_mismatch']),
    );
  });

  it('warns when a 2004 package writes cmi.core.* elements', async () => {
    const report = await validateScormPackage(
      buildScormZip({ version: '2004', extraFiles: [{ path: 'index.html', content: GOOD_HTML_12 }] }),
    );
    const mismatch = report.warnings.find((w) => w.code === 'cmi_element_version_mismatch');
    expect(mismatch?.message).toContain('cmi.core.lesson_status');
    expect(codes(report.warnings)).toContain('runtime_api_mismatch');
  });

  it('accepts version-agnostic wrappers that mention both APIs', async () => {
    const wrapper = `var a = win.API_1484_11 || win.API; if (v12) a.LMSInitialize(''); else a.Initialize('');
      set(v12 ? 'cmi.core.lesson_status' : 'cmi.completion_status', 'completed');`;
    const report = await validateScormPackage(
      buildScormZip({
        version: '2004',
        extraFiles: [
          { path: 'index.html', content: GOOD_HTML_2004 },
          { path: 'js/wrapper.js', content: wrapper },
        ],
      }),
    );
    expect(report.warnings).toEqual([]);
  });

  it('notes content that never references the runtime API', async () => {
    const report = await validateScormPackage(buildScormZip());
    expect(codes(report.info)).toContain('no_runtime_api_reference');
  });
});

describe('validateScormPackage — accessibility + assets', () => {
  it('flags missing lang, missing alt text and missing <title>', async () => {
    const html = '<html><head></head><body><img src="a.png"><img src="b.png" alt=""><IMG SRC="c.png"></body></html>';
    const report = await validateScormPackage(
      buildScormZip({ extraFiles: [{ path: 'index.html', content: html }] }),
    );
    expect(codes(report.warnings)).toEqual(expect.arrayContaining(['a11y_missing_lang', 'a11y_img_missing_alt']));
    expect(report.warnings.find((w) => w.code === 'a11y_img_missing_alt')?.message).toContain('2 <img>');
    expect(codes(report.info)).toContain('a11y_missing_title');
  });

  it('flags plugin content, large assets, heavy images and raw image formats', async () => {
    const report = await validateScormPackage(
      buildScormZip({
        extraFiles: [
          { path: 'index.html', content: GOOD_HTML_12 },
          { path: 'intro.swf', content: 'FWS' },
          { path: 'video.mp4', content: Buffer.alloc(3000) },
          { path: 'hero.png', content: Buffer.alloc(1500) },
          { path: 'scan.bmp', content: Buffer.alloc(10) },
        ],
      }),
      { largeAssetBytes: 2000, largeImageBytes: 1000, largePackageBytes: 4000 },
    );
    expect(codes(report.warnings)).toEqual(
      expect.arrayContaining(['deprecated_plugin_content', 'large_asset', 'large_package']),
    );
    expect(codes(report.info)).toEqual(expect.arrayContaining(['unoptimized_image', 'uncompressed_image_format']));
    expect(report.valid).toBe(true);
  });

  it('scans hostile markup in linear time', async () => {
    const hostile = '<img'.repeat(200_000) + 'cmi.'.repeat(100_000);
    const started = Date.now();
    await validateScormPackage(buildScormZip({ extraFiles: [{ path: 'evil.html', content: hostile }] }));
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('helpers', () => {
  it('resolveHref strips query/fragment and joins bases', () => {
    expect(resolveHref('a/b.html?x=1#y')).toBe('a/b.html');
    expect(resolveHref('page.html', 'content/', 'unit1/')).toBe('content/unit1/page.html');
    expect(resolveHref('./x.html')).toBe('x.html');
    expect(resolveHref('https://example.com/x')).toBeNull();
    expect(resolveHref('//cdn.example.com/x')).toBeNull();
  });

  it('findTags requires a tag-name boundary', () => {
    expect(findTags('<img a><imgx b><img/>', 'img')).toEqual([' a', '/']);
    expect(findTags('<img never closed', 'img')).toEqual([]);
  });
});
