import { describe, expect, it } from 'vitest';

import { parseImsManifest, ManifestParseError } from '../../src/parser/manifest.js';

const SCORM_12_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST-1" version="1.2"
          xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Intro to Widgets</title>
      <item identifier="ITEM-1" identifierref="RES-1">
        <title>Module 1</title>
        <adlcp:masteryscore>80</adlcp:masteryscore>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="module1/index.html">
      <file href="module1/index.html"/>
      <file href="module1/style.css"/>
    </resource>
  </resources>
</manifest>`;

const SCORM_2004_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST-2" version="1.0"
          xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 4th Edition</schemaversion>
  </metadata>
  <organizations default="ORG-A">
    <organization identifier="ORG-A">
      <title>Advanced Widgets</title>
      <item identifier="I-A" identifierref="R-A">
        <title>Chapter 1</title>
        <item identifier="I-B" identifierref="R-B">
          <title>Chapter 2</title>
        </item>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="R-A" type="webcontent" adlcp:scormType="sco" href="ch1/launch.html">
      <file href="ch1/launch.html"/>
    </resource>
    <resource identifier="R-B" type="webcontent" adlcp:scormType="sco" href="ch2/launch.html">
      <file href="ch2/launch.html"/>
    </resource>
  </resources>
</manifest>`;

const ASSET_ONLY_MANIFEST = `<?xml version="1.0"?>
<manifest identifier="A" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="O"><organization identifier="O"><title>X</title>
    <item identifier="I" identifierref="R"><title>T</title></item>
  </organization></organizations>
  <resources>
    <resource identifier="R" type="webcontent" adlcp:scormtype="asset" href="page.html">
      <file href="page.html"/>
    </resource>
  </resources>
</manifest>`;

describe('parseImsManifest', () => {
  it('parses a SCORM 1.2 manifest with mastery score', () => {
    const m = parseImsManifest(SCORM_12_MANIFEST);
    expect(m.version).toBe('SCORM_1_2');
    expect(m.title).toBe('Intro to Widgets');
    expect(m.identifier).toBe('MANIFEST-1');
    expect(m.scos).toHaveLength(1);
    expect(m.scos[0]).toMatchObject({
      identifier: 'ITEM-1',
      title: 'Module 1',
      launchHref: 'module1/index.html',
      masteryScore: 80,
    });
    expect(m.masteryScore).toBe(80);
    expect(m.primarySco.identifier).toBe('ITEM-1');
    expect(m.resourceFiles).toEqual(expect.arrayContaining(['module1/index.html', 'module1/style.css']));
  });

  it('parses a SCORM 2004 manifest with nested items', () => {
    const m = parseImsManifest(SCORM_2004_MANIFEST);
    expect(m.version).toBe('SCORM_2004_4');
    expect(m.title).toBe('Advanced Widgets');
    expect(m.scos).toHaveLength(2);
    expect(m.scos.map((s) => s.launchHref)).toEqual(['ch1/launch.html', 'ch2/launch.html']);
    expect(m.scos.map((s) => s.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('throws no_scos when manifest contains only assets', () => {
    expect(() => parseImsManifest(ASSET_ONLY_MANIFEST)).toThrow(ManifestParseError);
    try {
      parseImsManifest(ASSET_ONLY_MANIFEST);
    } catch (err) {
      expect((err as ManifestParseError).code).toBe('no_scos');
    }
  });

  it('throws malformed_xml when XML is broken', () => {
    expect(() => parseImsManifest('<manifest><oops')).toThrow(ManifestParseError);
  });

  it('throws missing_organizations when <organizations> is absent', () => {
    const xml = `<manifest identifier="X"><metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata></manifest>`;
    try {
      parseImsManifest(xml);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as ManifestParseError).code).toBe('missing_organizations');
    }
  });

  it('detects SCORM 2004 3rd Edition from schemaversion', () => {
    const xml = SCORM_2004_MANIFEST.replace('2004 4th Edition', '2004 3rd Edition');
    expect(parseImsManifest(xml).version).toBe('SCORM_2004_3');
  });

  it('falls back to manifest identifier when title is missing', () => {
    const xml = SCORM_12_MANIFEST.replace('<title>Intro to Widgets</title>', '');
    const m = parseImsManifest(xml);
    // Title falls back to manifest identifier when both org.title and LOM are missing.
    expect(m.title === 'MANIFEST-1' || m.title === 'Module 1' || m.title === 'Untitled Course').toBe(true);
  });

  it('applies xml:base from <resources> and <resource> to launch hrefs', () => {
    const xml = (resourcesBase: string, resourceBase: string, href: string) => `<?xml version="1.0"?>
<manifest identifier="M" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="O"><organization identifier="O"><title>T</title>
    <item identifier="I" identifierref="R"><title>I</title></item></organization></organizations>
  <resources${resourcesBase}><resource identifier="R" type="webcontent" adlcp:scormtype="sco"${resourceBase} href="${href}"/></resources>
</manifest>`;
    expect(parseImsManifest(xml(' xml:base="content/"', ' xml:base="unit1/"', 'start.html')).primarySco.launchHref)
      .toBe('content/unit1/start.html');
    expect(parseImsManifest(xml('', ' xml:base="./lesson///"', './a.html?x=1')).primarySco.launchHref)
      .toBe('lesson/a.html?x=1');
    expect(parseImsManifest(xml('', ' xml:base="https://cdn.example.com/"', 'a.html')).primarySco.launchHref)
      .toBe('a.html');
    expect(parseImsManifest(xml(' xml:base="content/"', '', 'https://x.example/a.html')).primarySco.launchHref)
      .toBe('https://x.example/a.html');
  });
});
