import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import { createTestEnv } from '../helpers/test-env.js';
import { buildScormZip } from '../helpers/scorm-fixture.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMockPrisma } from '../helpers/mock-prisma.js';

describe('POST /api/v1/courses', () => {
  let app: FastifyInstance;
  let storage: MemoryStorage;
  let apiKey: string;
  let tenantId: string;

  beforeEach(async () => {
    storage = new MemoryStorage();
    const { prisma, state } = createMockPrisma();
    apiKey = state.apiKeyPlaintext;
    tenantId = state.tenantId;
    app = await buildApp({ env: createTestEnv(), prisma, storage });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function buildMultipartBody(zip: Buffer, title?: string): { payload: Buffer; headers: Record<string, string> } {
    const boundary = '----test-boundary-12345';
    const parts: Buffer[] = [];
    const push = (s: string | Buffer) => parts.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));

    if (title !== undefined) {
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="title"\r\n\r\n`);
      push(`${title}\r\n`);
    }

    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="file"; filename="course.zip"\r\n`);
    push(`Content-Type: application/zip\r\n\r\n`);
    push(zip);
    push(`\r\n--${boundary}--\r\n`);

    return {
      payload: Buffer.concat(parts),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  it('rejects unauthenticated requests with 401', async () => {
    const zip = buildScormZip();
    const { payload, headers } = buildMultipartBody(zip);
    const res = await app.inject({ method: 'POST', url: '/api/v1/courses/', payload, headers });
    expect(res.statusCode).toBe(401);
  });

  it('uploads + persists a valid SCORM 1.2 package', async () => {
    const zip = buildScormZip({ title: 'Compliance 101' });
    const { payload, headers } = buildMultipartBody(zip);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/courses/',
      payload,
      headers: { ...headers, 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.title).toBe('Compliance 101');
    expect(body.version).toBe('SCORM_1_2');
    expect(body.scos).toHaveLength(1);
    expect(body.scos[0].launchHref).toBe('index.html');
    expect(body.primaryScoId).toBe('ITEM-1');
    expect(await storage.exists(`tenants/${tenantId}/courses/${body.id}/imsmanifest.xml`)).toBe(true);
  });

  it('honors the title override field', async () => {
    const zip = buildScormZip({ title: 'Original' });
    const { payload, headers } = buildMultipartBody(zip, 'Overridden');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/courses/',
      payload,
      headers: { ...headers, 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().title).toBe('Overridden');
  });

  it('returns 422 with a structured error for a non-SCORM zip', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const z = new AdmZip();
    z.addFile('readme.txt', Buffer.from('not scorm', 'utf8'));
    const { payload, headers } = buildMultipartBody(z.toBuffer());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/courses/',
      payload,
      headers: { ...headers, 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('missing_manifest');
  });

  it('returns 400 when no file is attached', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/courses/',
      payload: '--xx--\r\n',
      headers: { 'content-type': 'multipart/form-data; boundary=xx', 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/v1/courses/validate returns a validation report without persisting', async () => {
    const zip = buildScormZip();
    const { payload, headers } = buildMultipartBody(zip);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/courses/validate',
      payload,
      headers: { ...headers, 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.version).toBe('SCORM_1_2');
    expect(body.stats).toMatchObject({ fileCount: 2, launchableCount: 1 });
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.info.map((i: { code: string }) => i.code)).toContain('no_runtime_api_reference');
    expect(storage.files.size).toBe(0);
  });

  it('POST /api/v1/courses/validate reports a missing launch file as invalid', async () => {
    const zip = buildScormZip({
      manifestXml: `<?xml version="1.0"?>
<manifest identifier="M" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="O"><organization identifier="O"><title>T</title>
    <item identifier="I" identifierref="R"><title>I</title></item></organization></organizations>
  <resources><resource identifier="R" type="webcontent" adlcp:scormtype="sco" href="start.html"/></resources>
</manifest>`,
    });
    const { payload, headers } = buildMultipartBody(zip);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/courses/validate',
      payload,
      headers: { ...headers, 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.errors[0]).toMatchObject({
      code: 'missing_launch_file',
      severity: 'error',
      category: 'resources',
      path: 'start.html',
    });
  });
});
