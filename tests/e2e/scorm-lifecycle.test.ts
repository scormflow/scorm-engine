/**
 * End to end: upload → launch → track → resume → complete, through the real
 * Fastify app with every route, auth hook and service wired as in production.
 * Only Postgres and object storage are swapped for in-memory stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import type { WebhookDispatcher } from '../../src/webhooks/index.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMemoryDb, type MemoryDb } from '../helpers/memory-db.js';
import { buildScormZip } from '../helpers/scorm-fixture.js';

const TENANT = 'tenant_e2e';
const API_KEY = 'sk_test_e2e_lifecycle';
const LEARNER = { learnerId: 'learner-42', learnerName: 'Ada Lovelace' };

/** The edition-specific CMI vocabulary one lifecycle run speaks. */
interface Edition {
  name: string;
  zip: '1.2' | '2004';
  version: string;
  cmi: {
    entry: string;
    learnerId: string;
    location: string;
    exit: string;
    normalExit: string;
    sessionTime: (minutes: number) => string;
    progress: Record<string, string>;
    finish: Record<string, string>;
  };
  totalTime: (minutes: number) => string;
}

const hhmmss = (m: number) => `0000:${String(m).padStart(2, '0')}:00`;

const EDITIONS: Edition[] = [
  {
    name: 'SCORM 1.2',
    zip: '1.2',
    version: 'SCORM_1_2',
    cmi: {
      entry: 'cmi.core.entry',
      learnerId: 'cmi.core.student_id',
      location: 'cmi.core.lesson_location',
      exit: 'cmi.core.exit',
      normalExit: '',
      sessionTime: hhmmss,
      progress: {
        'cmi.core.lesson_status': 'incomplete',
        'cmi.objectives.0.id': 'obj-quiz',
        'cmi.objectives.0.status': 'incomplete',
        'cmi.interactions.0.id': 'q1',
        'cmi.interactions.0.type': 'choice',
        'cmi.interactions.0.student_response': 'b',
        'cmi.interactions.0.result': 'correct',
      },
      finish: {
        'cmi.core.lesson_status': 'passed',
        'cmi.core.score.raw': '90',
        'cmi.objectives.0.status': 'passed',
      },
    },
    totalTime: hhmmss,
  },
  {
    name: 'SCORM 2004',
    zip: '2004',
    version: 'SCORM_2004_4',
    cmi: {
      entry: 'cmi.entry',
      learnerId: 'cmi.learner_id',
      location: 'cmi.location',
      exit: 'cmi.exit',
      normalExit: 'normal',
      sessionTime: (m) => `PT${m}M`,
      progress: {
        'cmi.completion_status': 'incomplete',
        'cmi.progress_measure': '0.5',
        'cmi.objectives.0.id': 'obj-quiz',
        'cmi.objectives.0.completion_status': 'incomplete',
        'cmi.interactions.0.id': 'q1',
        'cmi.interactions.0.type': 'choice',
        'cmi.interactions.0.learner_response': 'b',
        'cmi.interactions.0.result': 'correct',
      },
      finish: {
        'cmi.completion_status': 'completed',
        'cmi.success_status': 'passed',
        'cmi.score.scaled': '0.9',
        'cmi.score.raw': '90',
        'cmi.progress_measure': '1',
        'cmi.objectives.0.success_status': 'passed',
      },
    },
    totalTime: (m) => `PT${m}M`,
  },
];

describe.each(EDITIONS)('SCORM lifecycle end to end ($name)', (edition) => {
  let app: FastifyInstance;
  let db: MemoryDb;
  let storage: MemoryStorage;
  let events: Array<{ type: string; data: Record<string, any> }>;
  const apiKey = { 'x-api-key': API_KEY };

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

  async function upload(): Promise<Record<string, any>> {
    const boundary = '----e2e-boundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="course.zip"\r\n` +
          'Content-Type: application/zip\r\n\r\n',
      ),
      buildScormZip({
        version: edition.zip,
        title: 'Safety Basics',
        extraFiles: [{ path: 'assets/app.js', content: 'window.loaded = true;' }],
      }),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      payload,
      headers: { ...apiKey, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  const startAttempt = (courseId: string) =>
    app.inject({ method: 'POST', url: `/api/v1/courses/${courseId}/attempts`, payload: LEARNER, headers: apiKey });

  async function mintToken(attemptId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/attempt-token',
      payload: { attemptId },
      headers: apiKey,
    });
    expect(res.statusCode).toBe(200);
    return res.json().token;
  }

  /** Open the hosted player the way an LMS iframe would; returns its runtime config. */
  async function launch(attemptId: string, token: string) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/play/${attemptId}?token=${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const match = /window\.__SCORMFLOW__ = (.*?);<\/script>/.exec(res.body);
    expect(match).not.toBeNull();
    const iframe = /<iframe id="sco"[^>]*\ssrc="([^"]+)"/.exec(res.body);
    expect(iframe).not.toBeNull();
    return { config: JSON.parse(match![1]!), contentUrl: iframe![1]!, cookie: sessionCookie(res) };
  }

  /** What the runtime bridge POSTs on LMSCommit / Commit and LMSFinish / Terminate. */
  const commit = (attemptId: string, token: string, values: Record<string, string>, terminate = false) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/commit`,
      headers: { authorization: `Bearer ${token}` },
      payload: { values, terminate },
    });

  it('uploads, launches, tracks, suspends, resumes and completes a course', async () => {
    // ── Upload ──────────────────────────────────────────────────────────
    const course = await upload();
    expect(course).toMatchObject({ title: 'Safety Basics', version: edition.version, status: 'ready' });
    expect(course.scos).toHaveLength(1);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/courses', headers: apiKey });
    expect(listed.json().data.map((c: any) => c.id)).toEqual([course.id]);
    expect([...storage.files.keys()].some((k) => k.endsWith('/assets/app.js'))).toBe(true);

    // ── Launch (session 1) ──────────────────────────────────────────────
    const started = await startAttempt(course.id);
    expect(started.statusCode).toBe(201);
    const attemptId: string = started.json().attemptId;
    expect(started.json()).toMatchObject({ resumed: false, entry: 'ab-initio', version: edition.version, cmi: {} });

    const token1 = await mintToken(attemptId);
    const session1 = await launch(attemptId, token1);
    expect(session1.config).toMatchObject({ attemptId, version: edition.version });
    expect(session1.config.cmi[edition.cmi.entry]).toBe('ab-initio');
    expect(session1.config.cmi[edition.cmi.learnerId]).toBe(LEARNER.learnerId);

    // The SCO and its sub-resources load through the cookie the player set.
    const contentUrl = session1.contentUrl;
    expect(contentUrl).toBe(`/api/v1/courses/${course.id}/content/index.html`);
    const page = await app.inject({ method: 'GET', url: contentUrl, headers: { cookie: session1.cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<html>');
    const asset = await app.inject({
      method: 'GET',
      url: `/api/v1/courses/${course.id}/content/assets/app.js`,
      headers: { cookie: session1.cookie },
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    const anonymous = await app.inject({ method: 'GET', url: contentUrl });
    expect(anonymous.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/runtime.js' })).statusCode).toBe(200);

    // ── Track ───────────────────────────────────────────────────────────
    const progress = await commit(attemptId, token1, {
      ...edition.cmi.progress,
      [edition.cmi.location]: 'module-2',
      'cmi.suspend_data': '{"page":2,"answers":["b"]}',
      [sessionKey(edition)]: edition.cmi.sessionTime(1),
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({ ok: true, terminated: false, suspended: false, warnings: [] });

    // ── Suspend (LMSFinish / Terminate with exit=suspend) ───────────────
    const suspended = await commit(
      attemptId,
      token1,
      { [edition.cmi.exit]: 'suspend', [sessionKey(edition)]: edition.cmi.sessionTime(2) },
      true,
    );
    expect(suspended.json()).toMatchObject({ ok: true, terminated: false, suspended: true });

    // ── Resume (session 2) ──────────────────────────────────────────────
    const resumed = await startAttempt(course.id);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ attemptId, resumed: true, entry: 'resume' });
    expect(resumed.json().launch.totalTime).toBe(edition.totalTime(2));

    const token2 = await mintToken(attemptId);
    const session2 = await launch(attemptId, token2);
    expect(session2.config.cmi[edition.cmi.entry]).toBe('resume');
    expect(session2.config.cmi[edition.cmi.location]).toBe('module-2');
    expect(session2.config.cmi['cmi.suspend_data']).toBe('{"page":2,"answers":["b"]}');
    // A fresh session: last session's exit and session_time are not replayed.
    expect(session2.config.cmi[edition.cmi.exit]).toBeUndefined();
    expect(session2.config.cmi[sessionKey(edition)]).toBeUndefined();

    const runtime = await app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${attemptId}/runtime`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(runtime.json()).toMatchObject({ entry: 'resume', status: 'IN_PROGRESS' });

    // ── Complete ────────────────────────────────────────────────────────
    const finished = await commit(
      attemptId,
      token2,
      { ...edition.cmi.finish, [edition.cmi.exit]: edition.cmi.normalExit, [sessionKey(edition)]: edition.cmi.sessionTime(3) },
      true,
    );
    expect(finished.json()).toMatchObject({ ok: true, terminated: true, suspended: false });
    expect(finished.json().summary).toMatchObject({ completionStatus: 'completed', successStatus: 'passed' });

    const afterwards = await commit(attemptId, token2, { [edition.cmi.location]: 'x' });
    expect(afterwards.statusCode).toBe(409);

    const read = await app.inject({ method: 'GET', url: `/api/v1/attempts/${attemptId}`, headers: apiKey });
    expect(read.statusCode).toBe(200);
    const attempt = read.json();
    expect(attempt).toMatchObject({
      status: 'COMPLETED',
      completionStatus: 'COMPLETED',
      successStatus: 'PASSED',
      lessonLocation: 'module-2',
      score: { raw: 90 },
      // Two sessions: 2 min banked at suspend + 3 min after resuming.
      sessionTimeSeconds: 300,
      totalTimeSeconds: 300,
    });
    expect(attempt.finishedAt).not.toBeNull();
    expect(attempt.objectives).toEqual([expect.objectContaining({ identifier: 'obj-quiz', successStatus: 'PASSED' })]);
    expect(attempt.interactions).toEqual([
      expect.objectContaining({ identifier: 'q1', type: 'choice', learnerResponse: 'b' }),
    ]);
    expect(db.tables.commitLogs).toHaveLength(3);

    // ── Webhooks saw the whole story, once each ─────────────────────────
    expect(events.map((e) => e.type)).toEqual([
      'attempt.started',
      'attempt.suspended',
      'course.completed',
      'course.passed',
      'score.updated',
      'attempt.terminated',
      'objective.mastered',
      'certificate.issued',
    ]);
    expect(events.every((e) => e.data.attemptId === attemptId)).toBe(true);

    // ── Certificate: issued once on completion, readable by the learner ──
    expect(db.tables.certificates).toHaveLength(1);
    const cert = await app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${attemptId}/certificate`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(cert.statusCode).toBe(200);
    expect(cert.json()).toMatchObject({
      attemptId,
      status: 'valid',
      learnerId: LEARNER.learnerId,
      learnerName: LEARNER.learnerName,
      courseTitle: 'Safety Basics',
      scorePercent: 90,
    });
    const pdf = await app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${attemptId}/certificate/pdf?token=${token2}`,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const verified = await app.inject({
      method: 'GET',
      url: `/api/v1/certificates/verify/${cert.json().serial.toLowerCase()}`,
    });
    expect(verified.json()).toMatchObject({ valid: true, learnerName: LEARNER.learnerName });

    // ── Retake: a brand-new attempt that carries the learner's prior time ──
    const retake = await startAttempt(course.id);
    expect(retake.statusCode).toBe(201);
    expect(retake.json().attemptId).not.toBe(attemptId);
    expect(retake.json()).toMatchObject({ resumed: false, entry: 'ab-initio', cmi: {} });
    expect(retake.json().launch.totalTime).toBe(edition.totalTime(5));
  });

  it('keeps tokens scoped to their own attempt and course content', async () => {
    const course = await upload();
    const mine = (await startAttempt(course.id)).json().attemptId;
    const other = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/courses/${course.id}/attempts`,
        payload: { learnerId: 'someone-else' },
        headers: apiKey,
      })
    ).json().attemptId;
    const token = await mintToken(mine);

    expect((await commit(other, token, { [edition.cmi.location]: 'x' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/play/${other}?token=${token}` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/play/${mine}?token=garbage` })).statusCode).toBe(401);
  });

  it('removes the course, its attempts and its stored files on delete', async () => {
    const course = await upload();
    const attemptId = (await startAttempt(course.id)).json().attemptId;
    const token = await mintToken(attemptId);
    const { cookie } = await launch(attemptId, token);

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/courses/${course.id}`, headers: apiKey });
    expect(del.statusCode).toBe(204);
    expect(storage.files.size).toBe(0);
    expect(db.tables.attempts).toHaveLength(0);
    const gone = await app.inject({
      method: 'GET',
      url: `/api/v1/courses/${course.id}/content/index.html`,
      headers: { cookie },
    });
    expect(gone.statusCode).toBe(401);
  });
});

function sessionKey(edition: Edition): string {
  return edition.zip === '1.2' ? 'cmi.core.session_time' : 'cmi.session_time';
}

/** The `name=value` pair of the player's attempt cookie, ready to send back. */
function sessionCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const raw = Array.isArray(header) ? header[0] : header;
  expect(raw).toBeDefined();
  return raw!.split(';')[0]!;
}
