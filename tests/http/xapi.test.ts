import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import { buildMultipart, parseMultipart } from '../../src/xapi/index.js';
import type { WebhookDispatcher } from '../../src/webhooks/index.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMockLrs, sampleStatement, type MockLrs } from '../helpers/mock-lrs.js';

const BASE = '/api/v1/xapi';
const ID_A = '11111111-1111-4111-8111-111111111111';
const AGENT = JSON.stringify({ mbox: 'mailto:ada@example.com' });
const ACTIVITY = 'http://example.com/courses/intro';

let app: FastifyInstance;
let lrs: MockLrs;

const headers = (extra: Record<string, string> = {}) => ({
  'x-api-key': lrs.apiKey,
  'x-experience-api-version': '1.0.3',
  ...extra,
});

beforeEach(async () => {
  lrs = createMockLrs();
  app = await buildApp({
    env: createTestEnv(),
    prisma: lrs.prisma,
    storage: new MemoryStorage(),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('xAPI protocol handling', () => {
  it('serves About without auth and advertises the version', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/about` });

    expect(res.statusCode).toBe(200);
    expect(res.json().version).toEqual(['1.0.3']);
    expect(res.headers['x-experience-api-version']).toBe('1.0.3');
  });

  it('rejects a request with no version header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/statements`,
      headers: { 'x-api-key': lrs.apiKey },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_version_header');
  });

  it('rejects an unsupported version', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/statements`,
      headers: headers({ 'x-experience-api-version': '2.0.0' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unsupported_version');
  });

  it('rejects a request with no API key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/statements`,
      headers: { 'x-experience-api-version': '1.0.3' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /xapi/statements', () => {
  it('stores a single statement and returns its id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/statements`,
      headers: headers(),
      payload: sampleStatement(),
    });

    expect(res.statusCode).toBe(200);
    const ids = res.json();
    expect(ids).toHaveLength(1);
    expect(lrs.statements).toHaveLength(1);
    expect(lrs.statements[0]!.tenantId).toBe(lrs.tenantId);
  });

  it('stores a batch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/statements`,
      headers: headers(),
      payload: [sampleStatement(), sampleStatement({ actor: { mbox: 'mailto:g@example.com' } })],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });

  it('rejects a malformed statement with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/statements`,
      headers: headers(),
      payload: { actor: { name: 'Ada' }, verb: { id: 'completed' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_statement');
  });

  it('publishes xapi.statement.stored to the webhook sink', async () => {
    const events: Array<{ tenantId: string; type: string; data: Record<string, any> }> = [];
    const spy = {
      enqueue: async ({ tenantId, type, data }: { tenantId: string; type: string; data: Record<string, any> }) =>
        events.push({ tenantId, type, data }),
      start: () => undefined,
      stop: async () => undefined,
    } as unknown as WebhookDispatcher;
    const hooked = await buildApp({ env: createTestEnv(), prisma: lrs.prisma, storage: new MemoryStorage(), webhooks: spy });
    await hooked.ready();
    try {
      const res = await hooked.inject({
        method: 'PUT',
        url: `${BASE}/statements?statementId=${ID_A}`,
        headers: headers(),
        payload: sampleStatement(),
      });
      expect(res.statusCode).toBe(204);
      expect(events).toEqual([
        expect.objectContaining({
          tenantId: lrs.tenantId,
          type: 'xapi.statement.stored',
          data: expect.objectContaining({ statementId: ID_A, objectId: ACTIVITY }),
        }),
      ]);
    } finally {
      await hooked.close();
    }
  });
});

describe('PUT /xapi/statements', () => {
  it('stores under the supplied id and returns 204', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${BASE}/statements?statementId=${ID_A}`,
      headers: headers(),
      payload: sampleStatement(),
    });

    expect(res.statusCode).toBe(204);
    expect(lrs.statements[0]!.statementId).toBe(ID_A);
  });

  it('requires statementId', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${BASE}/statements`,
      headers: headers(),
      payload: sampleStatement(),
    });

    expect(res.statusCode).toBe(400);
  });

  it('conflicts when a different statement already holds the id', async () => {
    await app.inject({
      method: 'PUT',
      url: `${BASE}/statements?statementId=${ID_A}`,
      headers: headers(),
      payload: sampleStatement(),
    });

    const res = await app.inject({
      method: 'PUT',
      url: `${BASE}/statements?statementId=${ID_A}`,
      headers: headers(),
      payload: sampleStatement({ verb: { id: 'http://example.com/verbs/other' } }),
    });

    expect(res.statusCode).toBe(409);
  });
});

describe('GET /xapi/statements', () => {
  beforeEach(async () => {
    await app.inject({
      method: 'POST',
      url: `${BASE}/statements`,
      headers: headers(),
      payload: [
        sampleStatement({ id: ID_A }),
        sampleStatement({
          actor: { mbox: 'mailto:grace@example.com' },
          object: { id: 'http://example.com/courses/advanced' },
        }),
      ],
    });
  });

  it('returns a StatementResult envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/statements`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.statements).toHaveLength(2);
    expect(body.more).toBe('');
    expect(res.headers['x-experience-api-consistent-through']).toBeDefined();
  });

  it('fetches one statement by id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/statements?statementId=${ID_A}`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(ID_A);
  });

  it('404s on an unknown statement id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/statements?statementId=99999999-9999-4999-8999-999999999999`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(404);
  });

  it('refuses to combine statementId with filters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/statements?statementId=${ID_A}&verb=http://example.com/v`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(400);
  });

  it('filters by agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/statements?agent=${encodeURIComponent(AGENT)}`,
      headers: headers(),
    });

    expect(res.json().statements).toHaveLength(1);
  });

  it('rejects an agent parameter that is not a valid actor', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/statements?agent=${encodeURIComponent('{"name":"Ada"}')}`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_agent');
  });

  it('emits a resumable more link when results are paged', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `${BASE}/statements?limit=1`,
      headers: headers(),
    });

    const more = first.json().more;
    expect(more).toContain('cursor=1');

    const second = await app.inject({ method: 'GET', url: more, headers: headers() });
    expect(second.statusCode).toBe(200);
    expect(second.json().statements).toHaveLength(1);
    expect(second.json().more).toBe('');
  });
});

describe('/xapi/activities/state', () => {
  const stateUrl = (params: Record<string, string>) =>
    `${BASE}/activities/state?${new URLSearchParams({
      activityId: ACTIVITY,
      agent: AGENT,
      ...params,
    }).toString()}`;

  it('round-trips a JSON document with an ETag', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: stateUrl({ stateId: 'bookmark' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { page: 2 },
    });
    expect(put.statusCode).toBe(204);
    expect(put.headers.etag).toBeDefined();

    const get = await app.inject({
      method: 'GET',
      url: stateUrl({ stateId: 'bookmark' }),
      headers: headers(),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ page: 2 });
    expect(get.headers.etag).toBe(put.headers.etag);
  });

  it('stores a non-JSON body verbatim', async () => {
    await app.inject({
      method: 'PUT',
      url: stateUrl({ stateId: 'notes' }),
      headers: headers({ 'content-type': 'text/plain' }),
      payload: 'hello',
    });

    const get = await app.inject({
      method: 'GET',
      url: stateUrl({ stateId: 'notes' }),
      headers: headers(),
    });
    expect(get.body).toBe('hello');
    expect(get.headers['content-type']).toContain('text/plain');
  });

  it('merges on POST', async () => {
    await app.inject({
      method: 'PUT',
      url: stateUrl({ stateId: 'bookmark' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { page: 2, notes: 'a' },
    });
    await app.inject({
      method: 'POST',
      url: stateUrl({ stateId: 'bookmark' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { page: 3 },
    });

    const get = await app.inject({
      method: 'GET',
      url: stateUrl({ stateId: 'bookmark' }),
      headers: headers(),
    });
    expect(get.json()).toEqual({ page: 3, notes: 'a' });
  });

  it('honours If-Match', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: stateUrl({ stateId: 'bookmark' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { page: 1 },
    });

    const stale = await app.inject({
      method: 'PUT',
      url: stateUrl({ stateId: 'bookmark' }),
      headers: headers({ 'content-type': 'application/json', 'if-match': '"stale"' }),
      payload: { page: 2 },
    });
    expect(stale.statusCode).toBe(412);

    const fresh = await app.inject({
      method: 'PUT',
      url: stateUrl({ stateId: 'bookmark' }),
      headers: headers({
        'content-type': 'application/json',
        'if-match': put.headers.etag as string,
      }),
      payload: { page: 2 },
    });
    expect(fresh.statusCode).toBe(204);
  });

  it('lists state ids when stateId is omitted', async () => {
    await app.inject({
      method: 'PUT',
      url: stateUrl({ stateId: 'bookmark' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { page: 1 },
    });
    await app.inject({
      method: 'PUT',
      url: stateUrl({ stateId: 'prefs' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { theme: 'dark' },
    });

    const res = await app.inject({ method: 'GET', url: stateUrl({}), headers: headers() });
    expect(res.statusCode).toBe(200);
    expect((res.json() as string[]).sort()).toEqual(['bookmark', 'prefs']);
  });

  it('404s on a missing document', async () => {
    const res = await app.inject({
      method: 'GET',
      url: stateUrl({ stateId: 'nope' }),
      headers: headers(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes one document and then all of them', async () => {
    await app.inject({
      method: 'PUT',
      url: stateUrl({ stateId: 'bookmark' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { page: 1 },
    });
    await app.inject({
      method: 'PUT',
      url: stateUrl({ stateId: 'prefs' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { theme: 'dark' },
    });

    const one = await app.inject({
      method: 'DELETE',
      url: stateUrl({ stateId: 'bookmark' }),
      headers: headers(),
    });
    expect(one.statusCode).toBe(204);
    expect(lrs.states).toHaveLength(1);

    const all = await app.inject({ method: 'DELETE', url: stateUrl({}), headers: headers() });
    expect(all.statusCode).toBe(204);
    expect(lrs.states).toHaveLength(0);
  });

  it('requires activityId and agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/activities/state?stateId=bookmark`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('/xapi/activities/profile', () => {
  const profileUrl = (params: Record<string, string>) =>
    `${BASE}/activities/profile?${new URLSearchParams({
      activityId: ACTIVITY,
      ...params,
    }).toString()}`;

  it('round-trips a JSON document with an ETag', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { theme: 'dark' },
    });
    expect(put.statusCode).toBe(204);
    expect(put.headers.etag).toBeDefined();

    const get = await app.inject({
      method: 'GET',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers(),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ theme: 'dark' });
    expect(get.headers.etag).toBe(put.headers.etag);
    expect(get.headers['last-modified']).toBeDefined();
  });

  it('merges on POST and replaces on PUT', async () => {
    await app.inject({
      method: 'PUT',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { theme: 'dark', lang: 'en' },
    });

    const post = await app.inject({
      method: 'POST',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { lang: 'fr' },
    });
    expect(post.statusCode).toBe(204);

    const merged = await app.inject({
      method: 'GET',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers(),
    });
    expect(merged.json()).toEqual({ theme: 'dark', lang: 'fr' });
  });

  it('stores a non-JSON body unchanged', async () => {
    await app.inject({
      method: 'PUT',
      url: profileUrl({ profileId: 'notes' }),
      headers: headers({ 'content-type': 'text/plain' }),
      payload: 'hello',
    });

    const get = await app.inject({
      method: 'GET',
      url: profileUrl({ profileId: 'notes' }),
      headers: headers(),
    });
    expect(get.statusCode).toBe(200);
    expect(get.body).toBe('hello');
    expect(get.headers['content-type']).toContain('text/plain');
  });

  it('honours If-Match', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { v: 1 },
    });

    const stale = await app.inject({
      method: 'PUT',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers({ 'content-type': 'application/json', 'if-match': '"stale"' }),
      payload: { v: 2 },
    });
    expect(stale.statusCode).toBe(412);

    const fresh = await app.inject({
      method: 'PUT',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers({
        'content-type': 'application/json',
        'if-match': put.headers.etag as string,
      }),
      payload: { v: 2 },
    });
    expect(fresh.statusCode).toBe(204);
  });

  it('lists profile ids when profileId is omitted', async () => {
    await app.inject({
      method: 'PUT',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { theme: 'dark' },
    });
    await app.inject({
      method: 'PUT',
      url: profileUrl({ profileId: 'layout' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { cols: 2 },
    });

    const res = await app.inject({ method: 'GET', url: profileUrl({}), headers: headers() });
    expect(res.statusCode).toBe(200);
    expect((res.json() as string[]).sort()).toEqual(['layout', 'prefs']);
  });

  it('404s on a missing document', async () => {
    const res = await app.inject({
      method: 'GET',
      url: profileUrl({ profileId: 'nope' }),
      headers: headers(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('profile_not_found');
  });

  it('deletes a document', async () => {
    await app.inject({
      method: 'PUT',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { theme: 'dark' },
    });

    const del = await app.inject({
      method: 'DELETE',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers(),
    });
    expect(del.statusCode).toBe(204);
    expect(lrs.profiles).toHaveLength(0);
  });

  it('requires activityId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/activities/profile?profileId=prefs`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires the version header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: profileUrl({ profileId: 'prefs' }),
      headers: { 'x-api-key': lrs.apiKey },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_version_header');
  });
});

describe('/xapi/agents/profile', () => {
  const profileUrl = (params: Record<string, string>) =>
    `${BASE}/agents/profile?${new URLSearchParams({ agent: AGENT, ...params }).toString()}`;

  it('round-trips a document keyed by agent', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { locale: 'en-GB' },
    });
    expect(put.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers(),
    });
    expect(get.json()).toEqual({ locale: 'en-GB' });
  });

  it('does not collide with the activity profile of the same profileId', async () => {
    await app.inject({
      method: 'PUT',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers({ 'content-type': 'application/json' }),
      payload: { owner: 'agent' },
    });
    await app.inject({
      method: 'PUT',
      url: `${BASE}/activities/profile?${new URLSearchParams({
        activityId: ACTIVITY,
        profileId: 'prefs',
      }).toString()}`,
      headers: headers({ 'content-type': 'application/json' }),
      payload: { owner: 'activity' },
    });

    expect(lrs.profiles).toHaveLength(2);
    const get = await app.inject({
      method: 'GET',
      url: profileUrl({ profileId: 'prefs' }),
      headers: headers(),
    });
    expect(get.json()).toEqual({ owner: 'agent' });
  });

  it('rejects an agent that is not valid JSON', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/agents/profile?agent=not-json&profileId=prefs`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_agent');
  });
});

describe('/xapi/activities and /xapi/agents', () => {
  it('returns an activity the LRS has seen', async () => {
    await app.inject({
      method: 'POST',
      url: `${BASE}/statements`,
      headers: headers({ 'content-type': 'application/json' }),
      payload: sampleStatement({
        object: { id: ACTIVITY, definition: { name: { 'en-US': 'Intro' } } },
      }),
    });

    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/activities?activityId=${encodeURIComponent(ACTIVITY)}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: ACTIVITY,
      definition: { name: { 'en-US': 'Intro' } },
    });
  });

  it('404s for an unknown activity', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}/activities?activityId=${encodeURIComponent('http://example.com/unknown')}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('activity_not_found');
  });

  it('requires activityId', async () => {
    const res = await app.inject({ method: 'GET', url: `${BASE}/activities`, headers: headers() });
    expect(res.statusCode).toBe(400);
  });

  it('returns a Person for an agent, known or not', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: `${BASE}/agents?agent=${encodeURIComponent(AGENT)}`,
      headers: headers(),
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({
      objectType: 'Person',
      mbox: ['mailto:ada@example.com'],
    });

    await app.inject({
      method: 'POST',
      url: `${BASE}/statements`,
      headers: headers({ 'content-type': 'application/json' }),
      payload: sampleStatement({ actor: { name: 'Ada', mbox: 'mailto:ada@example.com' } }),
    });

    const known = await app.inject({
      method: 'GET',
      url: `${BASE}/agents?agent=${encodeURIComponent(AGENT)}`,
      headers: headers(),
    });
    expect(known.json()).toMatchObject({ objectType: 'Person', name: ['Ada'] });
  });
});

describe('xAPI attachments', () => {
  const content = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x0d, 0x0a, 0xff]);
  const sha2 = createHash('sha256').update(content).digest('hex');
  const attachment = {
    usageType: 'http://id.tincanapi.com/attachment/certificate-of-completion',
    display: { 'en-US': 'Certificate' },
    contentType: 'application/pdf',
    length: content.length,
    sha2,
  };

  let storage: MemoryStorage;
  let lrsApp: FastifyInstance;

  beforeEach(async () => {
    storage = new MemoryStorage();
    lrsApp = await buildApp({ env: createTestEnv(), prisma: lrs.prisma, storage });
    await lrsApp.ready();
  });

  afterEach(async () => {
    await lrsApp.close();
  });

  function multipartRequest(statements: unknown, withBody = true) {
    return buildMultipart([
      { headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(statements)) },
      ...(withBody
        ? [
            {
              headers: {
                'Content-Type': 'application/pdf',
                'Content-Transfer-Encoding': 'binary',
                'X-Experience-API-Hash': sha2,
              },
              body: content,
            },
          ]
        : []),
    ]);
  }

  it('advertises attachment support', async () => {
    const res = await lrsApp.inject({ method: 'GET', url: `${BASE}/about` });
    expect(res.json().extensions['https://scormflow.dev/lrs/extensions/implemented']).toContain(
      'attachments',
    );
  });

  it('stores a statement and its attachment from a multipart POST', async () => {
    const req = multipartRequest([sampleStatement({ attachments: [attachment] })]);
    const res = await lrsApp.inject({
      method: 'POST',
      url: `${BASE}/statements`,
      headers: headers({ 'content-type': req.contentType }),
      payload: req.body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(storage.files.get(`tenants/${lrs.tenantId}/xapi-attachments/${sha2}`)).toEqual(content);
  });

  it('stores from a multipart PUT', async () => {
    const req = multipartRequest(sampleStatement({ attachments: [attachment] }));
    const res = await lrsApp.inject({
      method: 'PUT',
      url: `${BASE}/statements?statementId=${ID_A}`,
      headers: headers({ 'content-type': req.contentType }),
      payload: req.body,
    });

    expect(res.statusCode).toBe(204);
    expect(storage.files.size).toBe(1);
  });

  it('rejects a JSON-only statement that declares an attachment body', async () => {
    const res = await lrsApp.inject({
      method: 'POST',
      url: `${BASE}/statements`,
      headers: headers(),
      payload: sampleStatement({ attachments: [attachment] }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_attachment');
    expect(lrs.statements).toHaveLength(0);
  });

  it('accepts a JSON-only statement whose attachment is a fileUrl', async () => {
    const res = await lrsApp.inject({
      method: 'POST',
      url: `${BASE}/statements`,
      headers: headers(),
      payload: sampleStatement({
        attachments: [{ ...attachment, fileUrl: 'https://example.com/certificate.pdf' }],
      }),
    });

    expect(res.statusCode).toBe(200);
  });

  it('rejects a body whose hash does not match, storing nothing', async () => {
    const req = buildMultipart([
      {
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(sampleStatement({ attachments: [attachment] }))),
      },
      {
        headers: { 'Content-Transfer-Encoding': 'binary', 'X-Experience-API-Hash': sha2 },
        body: Buffer.from('tampered'),
      },
    ]);
    const res = await lrsApp.inject({
      method: 'POST',
      url: `${BASE}/statements`,
      headers: headers({ 'content-type': req.contentType }),
      payload: req.body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('attachment_hash_mismatch');
    expect(storage.files.size).toBe(0);
    expect(lrs.statements).toHaveLength(0);
  });

  it('returns JSON by default and multipart with attachments=true', async () => {
    const req = multipartRequest(sampleStatement({ attachments: [attachment] }));
    await lrsApp.inject({
      method: 'PUT',
      url: `${BASE}/statements?statementId=${ID_A}`,
      headers: headers({ 'content-type': req.contentType }),
      payload: req.body,
    });

    const plain = await lrsApp.inject({
      method: 'GET',
      url: `${BASE}/statements?statementId=${ID_A}`,
      headers: headers(),
    });
    expect(plain.headers['content-type']).toMatch(/^application\/json/);
    expect(plain.json().attachments[0].sha2).toBe(sha2);

    for (const url of [
      `${BASE}/statements?statementId=${ID_A}&attachments=true`,
      `${BASE}/statements?attachments=true`,
    ]) {
      const res = await lrsApp.inject({ method: 'GET', url, headers: headers() });
      expect(res.statusCode).toBe(200);
      const contentType = res.headers['content-type'] as string;
      expect(contentType).toMatch(/^multipart\/mixed; boundary=/);

      const parts = parseMultipart(res.rawPayload, /boundary=(.+)$/.exec(contentType)![1]!);
      expect(parts).toHaveLength(2);
      expect(parts[0]!.headers['content-type']).toBe('application/json');
      expect(parts[1]!.headers['x-experience-api-hash']).toBe(sha2);
      expect(parts[1]!.headers['content-type']).toBe('application/pdf');
      expect(parts[1]!.body.equals(content)).toBe(true);
    }
  });
});
