/**
 * SCO targeting end to end: `scoId` is the manifest identifier on every public
 * surface (start attempt, events, /play, launch-url) while `Attempt.scoId`
 * stores the `Sco` row id it is a foreign key to.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import type { WebhookDispatcher } from '../../src/webhooks/index.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMemoryDb, type MemoryDb } from '../helpers/memory-db.js';
import { buildScormZip } from '../helpers/scorm-fixture.js';

const TENANT = 'tenant_sco';
const API_KEY = 'sk_test_sco';
const apiKey = { 'x-api-key': API_KEY };

const twoScoZip = (secondHref = 'two.html') =>
  buildScormZip({
    manifestXml: `<?xml version="1.0"?>
<manifest identifier="M" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="O"><organization identifier="O"><title>Safety</title>
    <item identifier="ITEM-1" identifierref="R1"><title>Module 1</title></item>
    <item identifier="ITEM-2" identifierref="R2"><title>Module 2</title></item>
  </organization></organizations>
  <resources>
    <resource identifier="R1" type="webcontent" adlcp:scormtype="sco" href="index.html"/>
    <resource identifier="R2" type="webcontent" adlcp:scormtype="sco" href="${secondHref}"/>
  </resources>
</manifest>`,
    extraFiles: [{ path: secondHref, content: `<html>${secondHref}</html>` }],
  });

function multipart(zip: Buffer) {
  const boundary = '----sco-boundary';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="course.zip"\r\n` +
          'Content-Type: application/zip\r\n\r\n',
      ),
      zip,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { ...apiKey, 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('SCO targeting', () => {
  let app: FastifyInstance;
  let db: MemoryDb;
  let events: Array<{ type: string; data: Record<string, any> }>;
  let courseId: string;

  beforeEach(async () => {
    db = createMemoryDb({ tenantId: TENANT, apiKey: API_KEY });
    events = [];
    const webhooks = {
      enqueue: async ({ type, data }: { type: string; data: Record<string, any> }) => events.push({ type, data }),
      start: () => undefined,
      stop: async () => undefined,
    } as unknown as WebhookDispatcher;
    app = await buildApp({ env: createTestEnv(), prisma: db.prisma, storage: new MemoryStorage(), webhooks });
    await app.ready();
    const uploaded = await app.inject({ method: 'POST', url: '/api/v1/courses', ...multipart(twoScoZip()) });
    expect(uploaded.statusCode).toBe(201);
    courseId = uploaded.json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  const start = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/attempts`, payload, headers: apiKey });

  async function token(attemptId: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/attempt-token', payload: { attemptId }, headers: apiKey });
    return res.json().token;
  }

  const rowFor = (identifier: string) => db.tables.scos.find((s) => s.identifier === identifier)!;

  it('stores the Sco row id for a manifest identifier and reports the identifier', async () => {
    const res = await start({ learnerId: 'u1', scoId: 'ITEM-2' });
    expect(res.statusCode).toBe(201);
    const { attemptId } = res.json();

    expect(db.tables.attempts.find((a) => a.id === attemptId)!.scoId).toBe(rowFor('ITEM-2').id);
    expect(events.find((e) => e.type === 'attempt.started')!.data).toMatchObject({ scoId: 'ITEM-2' });

    const commit = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/commit`,
      payload: { values: { 'cmi.core.lesson_status': 'completed' }, terminate: true },
      headers: apiKey,
    });
    expect(commit.statusCode).toBe(200);
    expect(events.find((e) => e.type === 'course.completed')!.data).toMatchObject({ scoId: 'ITEM-2' });
  });

  it('resumes per SCO, whether addressed by identifier or row id', async () => {
    const first = (await start({ learnerId: 'u1', scoId: 'ITEM-2' })).json();
    const byRowId = await start({ learnerId: 'u1', scoId: rowFor('ITEM-2').id });
    expect(byRowId.statusCode).toBe(200);
    expect(byRowId.json()).toMatchObject({ attemptId: first.attemptId, resumed: true });

    const other = await start({ learnerId: 'u1', scoId: 'ITEM-1' });
    expect(other.statusCode).toBe(201);
    expect(other.json().attemptId).not.toBe(first.attemptId);
  });

  it('rejects an unknown SCO instead of failing on the foreign key', async () => {
    const res = await start({ learnerId: 'u1', scoId: 'NOPE' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('sco_not_found');
    expect(db.tables.attempts).toHaveLength(0);
  });

  it("launches the attempt's own SCO in /play, and 404s an unknown override", async () => {
    const { attemptId } = (await start({ learnerId: 'u1', scoId: 'ITEM-2' })).json();
    const t = await token(attemptId);

    const play = await app.inject({ method: 'GET', url: `/api/v1/play/${attemptId}?token=${t}` });
    expect(play.statusCode).toBe(200);
    expect(play.body).toContain(`/api/v1/courses/${courseId}/content/two.html`);

    const override = await app.inject({ method: 'GET', url: `/api/v1/play/${attemptId}?token=${t}&scoId=ITEM-1` });
    expect(override.body).toContain(`/api/v1/courses/${courseId}/content/index.html`);

    const missing = await app.inject({ method: 'GET', url: `/api/v1/play/${attemptId}?token=${t}&scoId=NOPE` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('sco_not_found');
  });

  it('keeps a pinned attempt on its release SCO after a republish moves it', async () => {
    const { attemptId } = (await start({ learnerId: 'u1', scoId: 'ITEM-2' })).json();
    const published = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${courseId}/versions`,
      ...multipart(twoScoZip('moved/two.html')),
    });
    expect(published.statusCode).toBe(201);

    const play = await app.inject({ method: 'GET', url: `/api/v1/play/${attemptId}?token=${await token(attemptId)}` });
    expect(play.body).toContain('/content/two.html');
    expect(play.body).not.toContain('/content/moved/two.html');
  });

  describe('GET /courses/:id/launch-url', () => {
    const launchUrl = (query: string, headers: Record<string, string> = apiKey) =>
      app.inject({ method: 'GET', url: `/api/v1/courses/${courseId}/launch-url?${query}`, headers });

    it("returns a signed URL to the attempt's SCO that serves the content", async () => {
      const { attemptId } = (await start({ learnerId: 'u1', scoId: 'ITEM-2' })).json();
      const res = await launchUrl(`attemptId=${attemptId}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.scoId).toBe('ITEM-2');
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const url = new URL(body.launchUrl);
      expect(url.pathname).toBe(`/api/v1/courses/${courseId}/content/two.html`);
      expect(url.searchParams.get('token')).toBe(body.token);

      // Loading it hands the token on as a cookie for relative sub-resources.
      const content = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
      expect(content.statusCode).toBe(200);
      expect(content.body).toBe('<html>two.html</html>');
      expect(content.headers['set-cookie']).toMatch(/^sf_attempt=.+; Path=\/api\/v1\/courses; HttpOnly; SameSite=Lax$/);
    });

    it('defaults to the primary entry and honours a scoId override', async () => {
      const { attemptId } = (await start({ learnerId: 'u1' })).json();
      const primary = (await launchUrl(`attemptId=${attemptId}`)).json();
      expect(primary.scoId).toBeNull();
      expect(new URL(primary.launchUrl).pathname).toMatch(/\/content\/index\.html$/);

      const second = (await launchUrl(`attemptId=${attemptId}&scoId=ITEM-2`)).json();
      expect(second.scoId).toBe('ITEM-2');
      expect(new URL(second.launchUrl).pathname).toMatch(/\/content\/two\.html$/);
    });

    it('uses a cross-site cookie over HTTPS', async () => {
      const { attemptId } = (await start({ learnerId: 'u1' })).json();
      const { launchUrl: href } = (await launchUrl(`attemptId=${attemptId}`, { ...apiKey, 'x-forwarded-proto': 'https' })).json();
      expect(href).toMatch(/^https:\/\//);
      const url = new URL(href);
      const content = await app.inject({
        method: 'GET',
        url: `${url.pathname}${url.search}`,
        headers: { 'x-forwarded-proto': 'https' },
      });
      expect(content.headers['set-cookie']).toMatch(/; Secure; SameSite=None; Partitioned$/);
    });

    it('validates its inputs', async () => {
      const { attemptId } = (await start({ learnerId: 'u1' })).json();
      expect((await launchUrl('')).statusCode).toBe(400);
      expect((await launchUrl('attemptId=missing')).json().code).toBe('attempt_not_found');
      expect((await launchUrl(`attemptId=${attemptId}&scoId=NOPE`)).json().code).toBe('sco_not_found');
      expect((await launchUrl(`attemptId=${attemptId}`, {})).statusCode).toBe(401);
    });
  });
});
