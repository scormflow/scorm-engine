/**
 * Git-style course versioning through the real app: publish, changelog, diff,
 * attempt pinning across releases, rollback, legacy baselines and cleanup.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import type { WebhookDispatcher } from '../../src/webhooks/index.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMemoryDb, type MemoryDb } from '../helpers/memory-db.js';
import { buildScormZip } from '../helpers/scorm-fixture.js';

const TENANT = 'tenant_versions';
const API_KEY = 'sk_test_versions';
const apiKey = { 'x-api-key': API_KEY };

function multipart(zip: Buffer, fields: Record<string, string> = {}) {
  const boundary = '----versions-boundary';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="course.zip"\r\n` +
        'Content-Type: application/zip\r\n\r\n',
    ),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    headers: { ...apiKey, 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const v1Zip = () =>
  buildScormZip({ title: 'Safety', extraFiles: [{ path: 'assets/app.js', content: 'v1();' }, { path: 'old.css', content: 'a{}' }] });
const v2Zip = () =>
  buildScormZip({ title: 'Safety', extraFiles: [{ path: 'assets/app.js', content: 'v2();' }, { path: 'new.css', content: 'b{}' }] });

describe('course versioning', () => {
  let app: FastifyInstance;
  let db: MemoryDb;
  let storage: MemoryStorage;
  let events: Array<{ type: string; data: Record<string, any> }>;

  beforeEach(async () => {
    db = createMemoryDb({ tenantId: TENANT, apiKey: API_KEY });
    storage = new MemoryStorage();
    events = [];
    const webhooks = {
      enqueue: async ({ type, data }: { type: string; data: Record<string, any> }) => events.push({ type, data }),
      start: () => undefined,
      stop: async () => undefined,
    } as unknown as WebhookDispatcher;
    app = await buildApp({ env: createTestEnv(), prisma: db.prisma, storage, webhooks });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function upload(fields: Record<string, string> = {}) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/courses', ...multipart(v1Zip(), fields) });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  const publish = (courseId: string, zip: Buffer, fields: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/versions`, ...multipart(zip, fields) });

  async function startAttempt(courseId: string, learnerId: string) {
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${courseId}/attempts`,
      payload: { learnerId },
      headers: apiKey,
    });
    expect(started.statusCode).toBe(201);
    const attemptId: string = started.json().attemptId;
    const token = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/attempt-token',
      payload: { attemptId },
      headers: apiKey,
    });
    return { attemptId, token: token.json().token as string };
  }

  const content = (courseId: string, path: string, token: string) =>
    app.inject({ method: 'GET', url: `/api/v1/courses/${courseId}/content/${path}?token=${token}` });

  it('records the first upload as release 1.0 with a hashed file inventory', async () => {
    const course = await upload({ releaseNotes: 'Initial release' });
    expect(course.currentVersion).toEqual({ number: 1, label: '1.0' });

    const res = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}/versions`, headers: apiKey });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentVersion).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      number: 1,
      label: '1.0',
      current: true,
      releaseNotes: 'Initial release',
      scormVersion: 'SCORM_1_2',
      launchHref: 'index.html',
      scoCount: 1,
      fileCount: 4,
    });
    expect(body.data[0].packageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(db.tables.courseVersions[0]!.files.every((f: any) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  it('publishes a new release, diffs it, and keeps running attempts pinned', async () => {
    const course = await upload();
    const early = await startAttempt(course.id, 'learner-early');

    const published = await publish(course.id, v2Zip(), { releaseNotes: 'New styles' });
    expect(published.statusCode).toBe(201);
    expect(published.json()).toMatchObject({ number: 2, label: '1.1', current: true, releaseNotes: 'New styles' });
    expect(events.map((e) => e.type)).toContain('course.version.published');
    expect(events.find((e) => e.type === 'course.version.published')!.data).toMatchObject({
      courseId: course.id,
      version: 2,
      label: '1.1',
      activated: true,
    });
    expect(await storage.exists(`tenants/${TENANT}/course-versions/${course.id}/2/new.css`)).toBe(true);

    const fetched = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}`, headers: apiKey });
    expect(fetched.json().currentVersion).toEqual({ number: 2, label: '1.1' });

    const diff = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}/versions/diff`, headers: apiKey });
    expect(diff.statusCode).toBe(200);
    expect(diff.json()).toMatchObject({
      from: { number: 1, label: '1.0' },
      to: { number: 2, label: '1.1' },
      identical: false,
      breakingChanges: [],
      assets: {
        added: [expect.objectContaining({ path: 'new.css' })],
        removed: [expect.objectContaining({ path: 'old.css' })],
        modified: [expect.objectContaining({ path: 'assets/app.js' })],
        unchangedCount: 2,
      },
    });

    // The attempt that started on 1.0 keeps getting 1.0's files …
    const earlyJs = await content(course.id, 'assets/app.js', early.token);
    expect(earlyJs.statusCode).toBe(200);
    expect(earlyJs.body).toBe('v1();');
    // … while a new attempt launches 1.1.
    const late = await startAttempt(course.id, 'learner-late');
    expect((await content(course.id, 'assets/app.js', late.token)).body).toBe('v2();');
    expect((await content(course.id, 'old.css', late.token)).statusCode).toBe(404);

    // API-key callers can read any release explicitly.
    const v1 = await app.inject({
      method: 'GET',
      url: `/api/v1/courses/${course.id}/content/assets/app.js?version=1`,
      headers: apiKey,
    });
    expect(v1.body).toBe('v1();');
  });

  it('rolls back to an earlier release without touching pinned attempts', async () => {
    const course = await upload();
    await publish(course.id, v2Zip());
    const onV2 = await startAttempt(course.id, 'learner-v2');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${course.id}/rollback`,
      payload: { version: 1 },
      headers: apiKey,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ number: 1, label: '1.0', current: true });
    expect(events.find((e) => e.type === 'course.version.rolled_back')!.data).toMatchObject({
      courseId: course.id,
      version: 1,
      previousVersion: 2,
    });

    const head = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}`, headers: apiKey });
    expect(head.json().currentVersion).toEqual({ number: 1, label: '1.0' });
    expect((await content(course.id, 'assets/app.js', onV2.token)).body).toBe('v2();');
    const fresh = await startAttempt(course.id, 'learner-after-rollback');
    expect((await content(course.id, 'assets/app.js', fresh.token)).body).toBe('v1();');

    // Rolling back to the live release is a no-op.
    events.length = 0;
    await app.inject({ method: 'POST', url: `/api/v1/courses/${course.id}/rollback`, payload: { version: 1 }, headers: apiKey });
    expect(events).toEqual([]);
  });

  it('keeps SCO rows (and their ids) in line with the live release', async () => {
    const course = await upload();
    const scoId = db.tables.scos[0]!.id;
    const twoScos = buildScormZip({
      manifestXml: `<?xml version="1.0"?>
<manifest identifier="M" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="O"><organization identifier="O"><title>Safety</title>
    <item identifier="ITEM-1" identifierref="R1"><title>Module 1 (revised)</title></item>
    <item identifier="ITEM-2" identifierref="R2"><title>Module 2</title></item>
  </organization></organizations>
  <resources>
    <resource identifier="R1" type="webcontent" adlcp:scormtype="sco" href="index.html"/>
    <resource identifier="R2" type="webcontent" adlcp:scormtype="sco" href="two.html"/>
  </resources>
</manifest>`,
      extraFiles: [{ path: 'two.html', content: '<html>2</html>' }],
    });
    expect((await publish(course.id, twoScos, { bump: 'major' })).json()).toMatchObject({ label: '2.0', scoCount: 2 });

    const res = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}`, headers: apiKey });
    expect(res.json().scos.map((s: any) => [s.identifier, s.title])).toEqual([
      ['ITEM-1', 'Module 1 (revised)'],
      ['ITEM-2', 'Module 2'],
    ]);
    expect(db.tables.scos.find((s) => s.identifier === 'ITEM-1')!.id).toBe(scoId);

    await app.inject({ method: 'POST', url: `/api/v1/courses/${course.id}/rollback`, payload: { version: 1 }, headers: apiKey });
    expect(db.tables.scos.map((s) => s.identifier)).toEqual(['ITEM-1']);

    const diff = await app.inject({
      method: 'GET',
      url: `/api/v1/courses/${course.id}/versions/diff?from=2&to=1`,
      headers: apiKey,
    });
    expect(diff.json().breakingChanges).toEqual(['SCO "ITEM-2" was removed']);
  });

  it('can publish a release without activating it', async () => {
    const course = await upload();
    const res = await publish(course.id, v2Zip(), { label: 'beta-1', activate: 'false' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ number: 2, label: 'beta-1', current: false });
    const head = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}`, headers: apiKey });
    expect(head.json().currentVersion).toEqual({ number: 1, label: '1.0' });
    // The next automatic label can't bump a free-form label, so it falls back to <number>.0.
    expect((await publish(course.id, v2Zip())).json().label).toBe('3.0');
  });

  it('edits release notes and fetches a single release', async () => {
    const course = await upload();
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/courses/${course.id}/versions/1`,
      payload: { releaseNotes: 'Fixed typo in module 1' },
      headers: apiKey,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().releaseNotes).toBe('Fixed typo in module 1');
    const one = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}/versions/1`, headers: apiKey });
    expect(one.json()).toMatchObject({ number: 1, releaseNotes: 'Fixed typo in module 1' });

    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/v1/courses/${course.id}/versions/1`,
      payload: { releaseNotes: 42 },
      headers: apiKey,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects duplicate labels, bad input and unknown releases', async () => {
    const course = await upload();
    const dup = await publish(course.id, v2Zip(), { label: '1.0' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('version_label_taken');
    expect((await publish(course.id, v2Zip(), { label: '../evil' })).statusCode).toBe(400);
    expect((await publish(course.id, v2Zip(), { bump: 'patch' })).statusCode).toBe(400);

    const missing = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}/versions/9`, headers: apiKey });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('version_not_found');
    const nan = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}/versions/abc`, headers: apiKey });
    expect(nan.statusCode).toBe(400);
    const noFrom = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}/versions/diff`, headers: apiKey });
    expect(noFrom.statusCode).toBe(400);
    const rollback = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${course.id}/rollback`,
      payload: { version: '1' },
      headers: apiKey,
    });
    expect(rollback.statusCode).toBe(400);
    const otherCourse = await app.inject({ method: 'GET', url: '/api/v1/courses/nope/versions', headers: apiKey });
    expect(otherCourse.statusCode).toBe(404);

    const invalidZip = await publish(course.id, Buffer.from('not a zip'));
    expect(invalidZip.statusCode).toBe(422);
    expect(db.tables.courseVersions).toHaveLength(1);
  });

  it('backfills a baseline for a course uploaded before versioning', async () => {
    const course = await upload();
    // Simulate a pre-versioning row: no releases, no head pointer.
    db.tables.courseVersions.length = 0;
    db.tables.courses[0]!.currentVersionId = null;

    const res = await publish(course.id, v2Zip());
    expect(res.json()).toMatchObject({ number: 2, label: '1.1' });
    const list = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}/versions`, headers: apiKey });
    expect(list.json().data.map((v: any) => [v.number, v.label, v.packageSha256])).toEqual([
      [2, '1.1', expect.any(String)],
      [1, '1.0', null],
    ]);
    const diff = await app.inject({ method: 'GET', url: `/api/v1/courses/${course.id}/versions/diff`, headers: apiKey });
    expect(diff.json().assets).toBeNull();
  });

  it('deletes every release from storage with the course', async () => {
    const course = await upload();
    await publish(course.id, v2Zip());
    expect([...storage.files.keys()].some((k) => k.includes('/course-versions/'))).toBe(true);
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/courses/${course.id}`, headers: apiKey });
    expect(res.statusCode).toBe(204);
    expect(storage.files.size).toBe(0);
    expect(db.tables.courseVersions).toHaveLength(0);
  });
});
