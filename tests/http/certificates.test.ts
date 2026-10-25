import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import { CertificateIssuer } from '../../src/certificates/index.js';
import type { WebhookDispatcher } from '../../src/webhooks/index.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMemoryDb, type MemoryDb } from '../helpers/memory-db.js';

const TENANT = 'tenant_cert';
const API_KEY = 'sk_test_certificates';
const apiKey = { 'x-api-key': API_KEY };

describe('certificates', () => {
  let app: FastifyInstance;
  let db: MemoryDb;
  let events: Array<{ type: string; data: Record<string, any> }>;

  async function start(env = createTestEnv()) {
    db = createMemoryDb({ tenantId: TENANT, apiKey: API_KEY });
    events = [];
    const webhooks = {
      emit: (_tenantId: string, type: string, data: Record<string, any>) => events.push({ type, data }),
      start: () => undefined,
      stop: async () => undefined,
    } as unknown as WebhookDispatcher;
    app = await buildApp({ env, prisma: db.prisma, storage: new MemoryStorage(), webhooks });
    await app.ready();
    db.tables.courses.push({
      id: 'course_1',
      tenantId: TENANT,
      title: 'Fire Safety',
      scormVersion: 'SCORM_2004_4',
      masteryScore: null,
    });
  }

  beforeEach(async () => start());
  afterEach(async () => app.close());

  async function newAttempt(learnerId = 'learner-1', learnerName: string | null = 'Grace Hopper') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/courses/course_1/attempts',
      payload: learnerName === null ? { learnerId } : { learnerId, learnerName },
      headers: apiKey,
    });
    expect(res.statusCode).toBe(201);
    return res.json().attemptId as string;
  }

  const commit = (attemptId: string, values: Record<string, string>, terminate = false) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/commit`,
      payload: { values, terminate },
      headers: apiKey,
    });

  const issuedEvents = () => events.filter((e) => e.type === 'certificate.issued');

  it('issues once, when the attempt first completes, and not again on terminate', async () => {
    const attemptId = await newAttempt();
    await commit(attemptId, { 'cmi.completion_status': 'incomplete' });
    expect(db.tables.certificates).toHaveLength(0);

    await commit(attemptId, { 'cmi.completion_status': 'completed', 'cmi.score.scaled': '0.8' });
    expect(db.tables.certificates).toHaveLength(1);
    await commit(attemptId, { 'cmi.exit': 'normal' }, true);
    expect(db.tables.certificates).toHaveLength(1);

    expect(issuedEvents()).toHaveLength(1);
    expect(issuedEvents()[0]!.data).toMatchObject({
      attemptId,
      courseId: 'course_1',
      learnerId: 'learner-1',
      learnerName: 'Grace Hopper',
      courseTitle: 'Fire Safety',
      scorePercent: 80,
    });
  });

  it('does not issue for a failed attempt', async () => {
    const attemptId = await newAttempt();
    await commit(attemptId, { 'cmi.completion_status': 'completed', 'cmi.success_status': 'failed' }, true);
    expect(db.tables.certificates).toHaveLength(0);

    const manual = await app.inject({ method: 'POST', url: `/api/v1/attempts/${attemptId}/certificate`, headers: apiKey });
    expect(manual.statusCode).toBe(409);
    expect(manual.json().code).toBe('attempt_not_eligible');
  });

  it('issues on demand, idempotently', async () => {
    const attemptId = await newAttempt('learner-2', null);
    // Completed before certificates were wired up for this attempt.
    Object.assign(db.tables.attempts.find((a) => a.id === attemptId)!, {
      status: 'COMPLETED',
      completionStatus: 'COMPLETED',
      successStatus: 'PASSED',
      finishedAt: new Date('2026-10-01T10:00:00Z'),
    });

    const first = await app.inject({ method: 'POST', url: `/api/v1/attempts/${attemptId}/certificate`, headers: apiKey });
    expect(first.statusCode).toBe(201);
    // No display name: falls back to the learner's external id.
    expect(first.json()).toMatchObject({ learnerName: 'learner-2', completedAt: '2026-10-01T10:00:00.000Z' });
    const again = await app.inject({ method: 'POST', url: `/api/v1/attempts/${attemptId}/certificate`, headers: apiKey });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);

    const missing = await app.inject({ method: 'POST', url: '/api/v1/attempts/nope/certificate', headers: apiKey });
    expect(missing.statusCode).toBe(404);
  });

  it('lists, filters, pages, reads, renders and revokes', async () => {
    const a1 = await newAttempt('learner-1');
    await commit(a1, { 'cmi.completion_status': 'completed' }, true);
    const a2 = await newAttempt('learner-2');
    await commit(a2, { 'cmi.completion_status': 'completed' }, true);
    // Distinct issue times for paging.
    db.tables.certificates[0]!.issuedAt = new Date('2026-10-10T00:00:00Z');
    db.tables.certificates[1]!.issuedAt = new Date('2026-10-11T00:00:00Z');

    const all = await app.inject({ method: 'GET', url: '/api/v1/certificates?limit=1', headers: apiKey });
    expect(all.json().data.map((c: any) => c.attemptId)).toEqual([a2]);
    expect(all.json().pagination).toEqual({ nextCursor: '2026-10-11T00:00:00.000Z', hasMore: true });
    const next = await app.inject({
      method: 'GET',
      url: `/api/v1/certificates?limit=1&before=${all.json().pagination.nextCursor}`,
      headers: apiKey,
    });
    expect(next.json()).toMatchObject({ data: [{ attemptId: a1 }], pagination: { nextCursor: null, hasMore: false } });

    const mine = await app.inject({ method: 'GET', url: '/api/v1/certificates?learnerId=learner-1', headers: apiKey });
    expect(mine.json().data.map((c: any) => c.attemptId)).toEqual([a1]);
    const nobody = await app.inject({ method: 'GET', url: '/api/v1/certificates?learnerId=ghost', headers: apiKey });
    expect(nobody.json().data).toEqual([]);
    const bad = await app.inject({ method: 'GET', url: '/api/v1/certificates?status=lost', headers: apiKey });
    expect(bad.statusCode).toBe(400);

    const id = mine.json().data[0].id as string;
    const one = await app.inject({ method: 'GET', url: `/api/v1/certificates/${id}`, headers: apiKey });
    expect(one.json()).toMatchObject({ id, status: 'valid', pdfUrl: `/api/v1/certificates/${id}/pdf` });

    const pdf = await app.inject({ method: 'GET', url: `/api/v1/certificates/${id}/pdf?download=1`, headers: apiKey });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="certificate-${one.json().serial}.pdf"`);
    expect(pdf.rawPayload.toString('latin1')).toContain('(ScormFlow Test Academy)');

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/certificates/${id}/revoke`,
      payload: { reason: 'Issued in error' },
      headers: apiKey,
    });
    expect(revoked.json()).toMatchObject({ status: 'revoked', revokedReason: 'Issued in error' });
    expect(events.filter((e) => e.type === 'certificate.revoked')).toHaveLength(1);
    // Revoking again keeps the original revocation and doesn't re-announce it.
    await app.inject({ method: 'POST', url: `/api/v1/certificates/${id}/revoke`, headers: apiKey });
    expect(events.filter((e) => e.type === 'certificate.revoked')).toHaveLength(1);

    const valid = await app.inject({ method: 'GET', url: '/api/v1/certificates?status=valid', headers: apiKey });
    expect(valid.json().data.map((c: any) => c.attemptId)).toEqual([a2]);
    const gone = await app.inject({ method: 'GET', url: '/api/v1/certificates?status=revoked', headers: apiKey });
    expect(gone.json().data.map((c: any) => c.id)).toEqual([id]);

    const verify = await app.inject({ method: 'GET', url: `/api/v1/certificates/verify/${one.json().serial}` });
    expect(verify.json()).toMatchObject({ valid: false, status: 'revoked', issuer: 'ScormFlow Test Academy' });
    const stamped = await app.inject({ method: 'GET', url: `/api/v1/certificates/${id}/pdf`, headers: apiKey });
    expect(stamped.rawPayload.toString('latin1')).toContain('(REVOKED)');
  });

  it('guards access', async () => {
    const attemptId = await newAttempt();
    await commit(attemptId, { 'cmi.completion_status': 'completed' }, true);

    expect((await app.inject({ method: 'GET', url: '/api/v1/certificates' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/v1/attempts/${attemptId}/certificate` })).statusCode).toBe(401);

    // An attempt token reads its own certificate, not someone else's.
    const other = await newAttempt('learner-9');
    const token = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/attempt-token', payload: { attemptId }, headers: apiKey })
    ).json().token;
    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${attemptId}/certificate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(own.statusCode).toBe(200);
    const theirs = await app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${other}/certificate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(theirs.statusCode).toBe(403);
    // Issuing needs the API key, not just an attempt token.
    const issue = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/certificate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(issue.statusCode).toBe(401);

    const noCert = await app.inject({ method: 'GET', url: `/api/v1/attempts/${other}/certificate`, headers: apiKey });
    expect(noCert.statusCode).toBe(404);
    expect(noCert.json().code).toBe('certificate_not_found');
    const unknown = await app.inject({ method: 'GET', url: '/api/v1/certificates/verify/0000-0000-0000' });
    expect(unknown.statusCode).toBe(404);
  });

  it('stays off when CERTIFICATES_ENABLED is false', async () => {
    await app.close();
    await start(createTestEnv({ CERTIFICATES_ENABLED: false }));
    const attemptId = await newAttempt();
    await commit(attemptId, { 'cmi.completion_status': 'completed' }, true);
    expect(db.tables.certificates).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/api/v1/certificates', headers: apiKey })).statusCode).toBe(404);
  });

  it('never fails the commit when issuing throws', async () => {
    const attemptId = await newAttempt();
    const logged: unknown[] = [];
    const issuer = new CertificateIssuer(db.prisma, { issuer: 'x' }, undefined, { error: (obj) => logged.push(obj) });
    (db.prisma as any).certificate.create = async () => {
      throw new Error('disk full');
    };
    await issuer.issueAfterCommit(TENANT, attemptId); // not eligible yet: no-op
    const res = await commit(attemptId, { 'cmi.completion_status': 'completed' }, true);
    expect(res.statusCode).toBe(200);
    expect(res.json().terminated).toBe(true);

    await issuer.issueAfterCommit(TENANT, attemptId);
    expect(logged).toHaveLength(1);
  });
});
