import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/http/app.js';
import type { WebhookDispatcher } from '../../src/webhooks/index.js';
import { createTestEnv } from '../helpers/test-env.js';
import { MemoryStorage } from '../helpers/memory-storage.js';
import { createMemoryDb, type MemoryDb } from '../helpers/memory-db.js';

const TENANT = 'tenant_ai';
const API_KEY = 'sk_test_ai';
const apiKey = { 'x-api-key': API_KEY };
const PROVIDER_KEY = 'sk-ant-api03-tenant-secret-9876';

interface ProviderCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

describe('AI analytics routes', () => {
  let app: FastifyInstance;
  let db: MemoryDb;
  let events: Array<{ type: string; data: Record<string, any> }>;
  let calls: ProviderCall[];
  let reply: { status: number; body: unknown };

  async function start(overrides: Parameters<typeof createTestEnv>[0] = { AI_MASTER_KEY: randomBytes(32).toString('hex') }) {
    db = createMemoryDb({ tenantId: TENANT, apiKey: API_KEY });
    events = [];
    calls = [];
    reply = {
      status: 200,
      body: { model: 'claude-test', content: [{ type: 'text', text: '- Completion is 50%.' }], usage: { input_tokens: 400, output_tokens: 100 } },
    };
    const webhooks = {
      enqueue: async ({ type, data }: { type: string; data: Record<string, any> }) => events.push({ type, data }),
      start: () => undefined,
      stop: async () => undefined,
    } as unknown as WebhookDispatcher;
    const aiFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch;
    app = await buildApp({
      env: createTestEnv(overrides),
      prisma: db.prisma,
      storage: new MemoryStorage(),
      webhooks,
      aiFetch,
    });
    await app.ready();
  }

  afterEach(async () => app?.close());

  function seedCourse() {
    db.tables.courses.push({
      id: 'course_1',
      tenantId: TENANT,
      title: 'Security Awareness',
      description: 'Questions? Mail trainer@corp.example.com',
      scormVersion: 'SCORM_2004_4',
      masteryScore: 0.8,
    });
    db.tables.learners.push({ id: 'l_row_1', tenantId: TENANT, externalId: 'emp-4471', name: 'Ada Lovelace' });
    const base = {
      tenantId: TENANT,
      courseId: 'course_1',
      learnerId: 'l_row_1',
      scoId: null,
      lessonStatus: 'INCOMPLETE',
      suspendData: null,
      scoreRaw: null,
      scoreMin: null,
      scoreMax: null,
      progressMeasure: null,
      totalTimeSeconds: 0,
      cmiSnapshot: {},
      lastCommitAt: null,
      finishedAt: null,
    };
    for (let i = 0; i < 4; i++) {
      const done = i < 2;
      db.tables.attempts.push({
        ...base,
        id: `att_${i}`,
        status: done ? 'COMPLETED' : 'IN_PROGRESS',
        completionStatus: done ? 'COMPLETED' : 'INCOMPLETE',
        successStatus: i === 0 ? 'PASSED' : i === 1 ? 'FAILED' : 'UNKNOWN',
        lessonLocation: done ? null : 'slide-08',
        scoreScaled: done ? 0.6 + i * 0.3 : null,
        sessionTimeSeconds: 600,
        startedAt: new Date(Date.UTC(2026, 9, 10 + i)),
      });
      db.tables.objectives.push({
        id: `obj_${i}`,
        attemptId: `att_${i}`,
        index: 0,
        identifier: 'phishing',
        description: 'Spot a phishing email',
        successStatus: i === 0 ? 'PASSED' : 'FAILED',
      });
      db.tables.interactions.push({
        id: `int_${i}`,
        attemptId: `att_${i}`,
        index: 0,
        identifier: 'q3',
        type: 'fill-in',
        description: 'Who should you report phishing to?',
        result: i === 0 ? 'correct' : 'incorrect',
        learnerResponse: i === 0 ? 'security team' : 'ada.lovelace@corp.example.com',
      });
    }
  }

  const put = (feature: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/v1/ai/providers/${feature}`, payload, headers: apiKey });

  const insight = (payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/v1/ai/insights', payload, headers: apiKey });

  it('is not mounted without AI_MASTER_KEY', async () => {
    await start({});
    const res = await app.inject({ method: 'GET', url: '/api/v1/ai/providers', headers: apiKey });
    expect(res.statusCode).toBe(404);
  });

  it('requires an API key', async () => {
    await start();
    const res = await app.inject({ method: 'GET', url: '/api/v1/ai/providers' });
    expect(res.statusCode).toBe(401);
  });

  it('stores the provider key encrypted and never returns it', async () => {
    await start();
    const created = await put('default', { provider: 'anthropic', model: 'claude-test', apiKey: PROVIDER_KEY });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      feature: 'default',
      provider: 'anthropic',
      model: 'claude-test',
      hasKey: true,
      keyHint: '…9876',
      redactPii: true,
      enabled: true,
      alertThreshold: 0.8,
    });
    expect(created.body).not.toContain('tenant-secret');
    expect(JSON.stringify(db.tables.aiConfigs)).not.toContain('tenant-secret');

    // Omitting apiKey keeps the stored key.
    const updated = await put('default', { provider: 'anthropic', model: 'claude-other', monthlyTokenCap: 5000 });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ model: 'claude-other', hasKey: true, monthlyTokenCap: 5000 });

    const list = await app.inject({ method: 'GET', url: '/api/v1/ai/providers', headers: apiKey });
    expect(list.json().data).toHaveLength(1);
    expect(list.body).not.toContain('encrypted');
  });

  it('validates configs', async () => {
    await start();
    expect((await put('nope', { provider: 'openai', model: 'm', apiKey: 'k' })).statusCode).toBe(400);
    expect((await put('default', { provider: 'skynet', model: 'm' })).json().code).toBe('invalid_request');
    expect((await put('default', { provider: 'openai', model: 'm' })).json().message).toMatch(/needs an apiKey/);
    expect((await put('default', { provider: 'ollama', model: 'llama3' })).json().message).toMatch(/AI_ALLOW_PRIVATE_URLS/);
    expect((await put('default', { provider: 'skynet', model: 'm' })).json().message).toMatch(/bedrock, custom_http/);
    expect((await put('default', { provider: 'bedrock', model: 'm', apiKey: 'k' })).json().message).toMatch(
      /baseUrl is required for provider bedrock/,
    );
    const bedrock = await put('insights', {
      provider: 'bedrock',
      model: 'anthropic.claude-test-v1:0',
      apiKey: 'AKIAIOSFODNN7EXAMPLE:secret-access-key',
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    });
    expect(bedrock.statusCode).toBe(201);
    expect(bedrock.body).not.toContain('secret-access-key');
    expect(
      (await put('recommendations', { provider: 'azure_openai', model: 'dep', apiKey: 'az', baseUrl: 'https://acme.openai.azure.com' })).json()
        .baseUrl,
    ).toBe('https://acme.openai.azure.com');
    expect(
      (await put('default', { provider: 'openai', model: 'm', apiKey: 'k', alertThreshold: 2 })).json().message,
    ).toMatch(/alertThreshold/);
    // Switching provider drops the old provider's key.
    await put('summary', { provider: 'anthropic', model: 'm', apiKey: PROVIDER_KEY });
    expect((await put('summary', { provider: 'openai', model: 'm' })).statusCode).toBe(400);
  });

  it('tests a key without storing or logging anything', async () => {
    await start();
    reply.body = { model: 'claude-test', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 1 } };
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/providers/test',
      payload: { provider: 'anthropic', model: 'claude-test', apiKey: PROVIDER_KEY },
      headers: apiKey,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, provider: 'anthropic', model: 'claude-test' });
    expect(calls[0]!.headers['x-api-key']).toBe(PROVIDER_KEY);

    reply = { status: 401, body: { error: { message: 'invalid x-api-key' } } };
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/providers/test',
      payload: { provider: 'anthropic', model: 'claude-test', apiKey: 'wrong' },
      headers: apiKey,
    });
    expect(bad.json()).toMatchObject({ ok: false, error: { code: 'ai_provider_auth' } });
    expect(db.tables.aiConfigs).toHaveLength(0);
    expect(db.tables.aiCalls).toHaveLength(0);
  });

  it('generates a course insight from aggregates, with PII redacted and the call logged', async () => {
    await start();
    seedCourse();
    await put('default', {
      provider: 'anthropic',
      model: 'claude-test',
      apiKey: PROVIDER_KEY,
      inputCostPerMTok: 3,
      outputCostPerMTok: 15,
    });

    const res = await insight({ kind: 'insights', courseId: 'course_1', question: 'Why do people stop? Ask me at boss@corp.example.com' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      kind: 'insights',
      scope: 'course',
      courseId: 'course_1',
      feature: 'default',
      provider: 'anthropic',
      model: 'claude-test',
      text: '- Completion is 50%.',
      usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500, costUsd: 0.0027 },
      sample: { attempts: 4, truncated: false },
    });
    // Course description, the question, and the (deduplicated) wrong answer.
    expect(body.redactions.counts.email).toBe(3);

    const sent = calls[0]!;
    expect(sent.headers['x-api-key']).toBe(PROVIDER_KEY);
    const prompt: string = sent.body.messages[0].content;
    // Grounded in the aggregates…
    expect(prompt).toContain('"completionRate": 0.5');
    expect(prompt).toContain('"location": "slide-08"');
    expect(prompt).toContain('"id": "phishing"');
    expect(prompt).toContain('Why do people stop?');
    // …with no learner identity and no raw email addresses.
    for (const leak of ['emp-4471', 'Ada Lovelace', 'l_row_1', 'att_0', 'corp.example.com']) {
      expect(prompt).not.toContain(leak);
    }
    expect(prompt).toContain('[EMAIL]');

    expect(db.tables.aiCalls).toHaveLength(1);
    expect(db.tables.aiCalls[0]).toMatchObject({
      tenantId: TENANT,
      status: 'succeeded',
      kind: 'insights',
      inputTokens: 400,
      outputTokens: 100,
      redactions: 3,
    });
    expect(db.tables.aiCalls[0]!.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('grounds course insights in the replay journey: reach per location and the steepest drop', async () => {
    await start();
    seedCourse();
    // Finished attempts walk all ten slides; unfinished ones stop at slide 8.
    for (let i = 0; i < 4; i++) {
      const last = i < 2 ? 10 : 8;
      for (let s = 1; s <= last; s++) {
        const at = new Date(Date.UTC(2026, 9, 10 + i, 9, s));
        db.tables.commitLogs.push({
          id: `log_${i}_${s}`,
          attemptId: `att_${i}`,
          values: { 'cmi.location': `slide-${String(s).padStart(2, '0')}` },
          recordedAt: at,
          createdAt: at,
        });
      }
    }
    await put('default', { provider: 'anthropic', model: 'claude-test', apiKey: PROVIDER_KEY });

    const res = await insight({ kind: 'insights', courseId: 'course_1' });
    expect(res.statusCode).toBe(200);
    const prompt: string = calls[0]!.body.messages[0].content;
    const data = JSON.parse(/```json\n([\s\S]*)\n```/.exec(prompt)![1]!);
    expect(data.journey).toMatchObject({ attempts: 4, completed: 2, truncated: false });
    expect(data.journey.locations).toHaveLength(10);
    expect(data.journey.locations[0]).toMatchObject({ location: 'slide-01', reached: 4, reachRate: 1 });
    expect(data.journey.locations[7]).toMatchObject({ location: 'slide-08', reached: 4, dropOffs: 2, dropOffRate: 0.5 });
    expect(data.journey.locations[8]).toMatchObject({ location: 'slide-09', reached: 2, reachRate: 0.5 });
    expect(data.journey.steepestDrops).toEqual([
      { after: 'slide-08', next: 'slide-09', reachBefore: 1, reachAfter: 0.5, drop: 0.5 },
    ]);
    // Still cohorts, not people.
    for (const leak of ['emp-4471', 'Ada Lovelace', 'att_0']) expect(prompt).not.toContain(leak);
  });

  it('leaves the journey out of tenant-wide insights', async () => {
    await start();
    seedCourse();
    await put('default', { provider: 'anthropic', model: 'claude-test', apiKey: PROVIDER_KEY });
    await insight({ kind: 'insights' });
    expect(calls[0]!.body.messages[0].content).not.toContain('"journey"');
  });

  it('sends the prompt unredacted when the tenant turns redaction off', async () => {
    await start();
    seedCourse();
    await put('default', { provider: 'anthropic', model: 'claude-test', apiKey: PROVIDER_KEY, redactPii: false });
    const res = await insight({ courseId: 'course_1' });
    expect(res.json().redactions.count).toBe(0);
    expect(calls[0]!.body.messages[0].content).toContain('trainer@corp.example.com');
  });

  it('prefers a feature’s own config over the default', async () => {
    await start();
    seedCourse();
    await put('default', { provider: 'anthropic', model: 'claude-test', apiKey: PROVIDER_KEY });
    await put('summary', { provider: 'openai', model: 'gpt-test', apiKey: 'sk-openai' });
    reply.body = { choices: [{ message: { content: 'Summary.' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };

    const res = await insight({ kind: 'summary' });
    expect(res.json()).toMatchObject({ feature: 'summary', provider: 'openai', scope: 'tenant', text: 'Summary.' });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.body.messages[1].content).toContain('"title": "Security Awareness"');
  });

  it('answers 404 when nothing is configured or the course is unknown', async () => {
    await start();
    expect((await insight()).json().code).toBe('ai_not_configured');
    await put('default', { provider: 'anthropic', model: 'claude-test', apiKey: PROVIDER_KEY });
    const res = await insight({ courseId: 'missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('course_not_found');
    expect(calls).toHaveLength(0);
  });

  it('honours the kill-switch', async () => {
    await start();
    await put('default', { provider: 'anthropic', model: 'claude-test', apiKey: PROVIDER_KEY, enabled: false });
    const res = await insight();
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ai_disabled');
    expect(calls).toHaveLength(0);
  });

  it('alerts at the threshold and blocks once the monthly cap is used', async () => {
    await start();
    seedCourse();
    await put('default', {
      provider: 'anthropic',
      model: 'claude-test',
      apiKey: PROVIDER_KEY,
      monthlyTokenCap: 1000,
      alertThreshold: 0.5,
    });

    expect((await insight()).statusCode).toBe(200); // 500 tokens: crosses 50%
    await app.events.idle();
    expect(events.filter((e) => e.type === 'ai.budget.alert').map((e) => e.data.level)).toEqual(['threshold']);

    expect((await insight()).statusCode).toBe(200); // 1000 tokens: reaches the cap
    await app.events.idle();
    expect(events.filter((e) => e.type === 'ai.budget.alert').map((e) => e.data.level)).toEqual([
      'threshold',
      'exhausted',
    ]);

    const blocked = await insight();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('ai_budget_exceeded');
    expect(calls).toHaveLength(2);

    const usage = await app.inject({ method: 'GET', url: '/api/v1/ai/usage', headers: apiKey });
    expect(usage.json().data[0]).toMatchObject({
      feature: 'default',
      calls: 2,
      tokensUsed: 1000,
      monthlyTokenCap: 1000,
      alerting: true,
      exhausted: true,
    });
    expect(usage.json().month).toMatch(/^\d{4}-\d{2}$/);
  });

  it('logs failed provider calls and passes the error through', async () => {
    await start();
    await put('default', { provider: 'anthropic', model: 'claude-test', apiKey: PROVIDER_KEY });
    reply = { status: 500, body: { error: { message: 'upstream exploded' } } };
    const res = await insight();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'ai_provider_error' });
    expect(db.tables.aiCalls[0]).toMatchObject({ status: 'failed' });
    expect(db.tables.aiCalls[0]!.error).toContain('upstream exploded');
  });

  it('lists the call log as JSON and CSV', async () => {
    await start();
    await put('default', { provider: 'anthropic', model: 'claude-test', apiKey: PROVIDER_KEY });
    await insight();
    await insight({ kind: 'recommendations' });

    const json = await app.inject({ method: 'GET', url: '/api/v1/ai/calls?limit=1', headers: apiKey });
    expect(json.json().data).toHaveLength(1);
    expect(json.json().pagination.hasMore).toBe(true);

    const csv = await app.inject({ method: 'GET', url: '/api/v1/ai/calls?format=csv', headers: apiKey });
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.trim().split('\n');
    expect(lines[0]).toBe(
      'id,createdAt,feature,kind,provider,model,courseId,status,inputTokens,outputTokens,costUsd,redactions,latencyMs,promptHash,error',
    );
    expect(lines).toHaveLength(3);
  });

  it('deletes a config', async () => {
    await start();
    await put('insights', { provider: 'anthropic', model: 'claude-test', apiKey: PROVIDER_KEY });
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/ai/providers/insights', headers: apiKey });
    expect(del.statusCode).toBe(204);
    const get = await app.inject({ method: 'GET', url: '/api/v1/ai/providers/insights', headers: apiKey });
    expect(get.statusCode).toBe(404);
  });
});
