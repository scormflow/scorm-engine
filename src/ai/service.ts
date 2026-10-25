import { createHash } from 'node:crypto';

import type { PrismaClient } from '../db/client.js';
import type { EventSink } from '../webhooks/events.js';
import { buildInsightContext, type HeatmapLoader } from './context.js';
import { KeyVault, keyHint } from './keys.js';
import { buildPrompt, INSIGHT_KINDS, type InsightKind } from './prompts.js';
import {
  AiProviderError,
  createProvider,
  isAiProviderId,
  providerNeedsKey,
  resolveBaseUrl,
  type AiProviderId,
} from './providers.js';
import { redactPii, type PiiKind } from './redact.js';

/**
 * Tenant AI settings, insight generation, cost controls and the call log.
 *
 * A tenant stores one provider config per feature (`insights`, `summary`,
 * `recommendations`) and/or a `default` used by any feature without its own.
 * Each config carries its own monthly token cap, so one key can be budgeted
 * for summaries and another for recommendations.
 */

export const AI_FEATURES = ['default', ...INSIGHT_KINDS] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export function isAiFeature(value: unknown): value is AiFeature {
  return typeof value === 'string' && (AI_FEATURES as readonly string[]).includes(value);
}

export class AiError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 429,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface AiServiceOptions {
  prisma: PrismaClient;
  vault: KeyVault;
  events?: EventSink | undefined;
  allowPrivateUrls?: boolean | undefined;
  timeoutMs?: number | undefined;
  /** Largest answer requested from the model. Default 1024 tokens. */
  maxOutputTokens?: number | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
  /** Session-replay heatmaps: course insights then include the learner journey. */
  heatmap?: HeatmapLoader | undefined;
}

export interface AiConfigInput {
  provider?: unknown;
  model?: unknown;
  /** Omit to keep the stored key (same provider only); `null` removes it. */
  apiKey?: unknown;
  baseUrl?: unknown;
  redactPii?: unknown;
  enabled?: unknown;
  monthlyTokenCap?: unknown;
  alertThreshold?: unknown;
  inputCostPerMTok?: unknown;
  outputCostPerMTok?: unknown;
}

export interface AiConfigView {
  feature: AiFeature;
  provider: AiProviderId;
  model: string;
  baseUrl: string | null;
  hasKey: boolean;
  keyHint: string | null;
  redactPii: boolean;
  enabled: boolean;
  monthlyTokenCap: number | null;
  alertThreshold: number;
  inputCostPerMTok: number | null;
  outputCostPerMTok: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerateInput {
  kind: InsightKind;
  courseId?: string | undefined;
  question?: string | undefined;
}

export interface InsightResult {
  id: string;
  kind: InsightKind;
  scope: 'course' | 'tenant';
  courseId: string | null;
  feature: AiFeature;
  provider: AiProviderId;
  model: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number | null };
  redactions: { count: number; counts: Partial<Record<PiiKind, number>> };
  sample: { attempts: number; truncated: boolean; from: string | null; to: string | null };
  generatedAt: string;
}

export interface AiUsageView {
  feature: AiFeature;
  provider: AiProviderId;
  model: string;
  calls: number;
  tokensUsed: number;
  costUsd: number | null;
  monthlyTokenCap: number | null;
  alertThreshold: number;
  /** Usage has reached `alertThreshold` of the cap. */
  alerting: boolean;
  /** Usage has reached the cap; calls are refused until the month turns. */
  exhausted: boolean;
}

export interface AiCallView {
  id: string;
  feature: string;
  kind: string;
  provider: string;
  model: string;
  courseId: string | null;
  status: 'succeeded' | 'failed' | 'blocked';
  promptHash: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  redactions: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

type ConfigRow = {
  id: string;
  tenantId: string;
  feature: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  encryptedKey: string | null;
  wrappedKey: string | null;
  keyHint: string | null;
  redactPii: boolean;
  enabled: boolean;
  monthlyTokenCap: number | null;
  alertThreshold: number;
  inputCostPerMTok: number | null;
  outputCostPerMTok: number | null;
  createdAt: Date;
  updatedAt: Date;
};

const MAX_QUESTION = 500;

export class AiService {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;

  constructor(private readonly options: AiServiceOptions) {
    this.prisma = options.prisma;
    this.now = options.now ?? (() => new Date());
  }

  // ---- configs -------------------------------------------------------------

  async listConfigs(tenantId: string): Promise<{ data: AiConfigView[] }> {
    const rows = (await this.prisma.aiProviderConfig.findMany({
      where: { tenantId },
      orderBy: { feature: 'asc' },
    })) as ConfigRow[];
    return { data: rows.map(serializeConfig) };
  }

  async getConfig(tenantId: string, feature: AiFeature): Promise<AiConfigView> {
    return serializeConfig(await this.requireConfig(tenantId, feature));
  }

  async putConfig(tenantId: string, feature: AiFeature, input: AiConfigInput): Promise<{ config: AiConfigView; created: boolean }> {
    if (!isAiProviderId(input.provider)) {
      throw new AiError(400, 'invalid_request', 'provider must be one of openai, anthropic, gemini, mistral, ollama, openai_compatible');
    }
    const provider = input.provider;
    const model = requireString(input.model, 'model', 200);
    const baseUrl = optionalString(input.baseUrl, 'baseUrl', 500);
    resolveBaseUrl(provider, baseUrl, this.options.allowPrivateUrls ?? false);

    const existing = (await this.prisma.aiProviderConfig.findUnique({
      where: { tenantId_feature: { tenantId, feature } },
    })) as ConfigRow | null;

    let key: { encryptedKey: string | null; wrappedKey: string | null; keyHint: string | null };
    if (input.apiKey === undefined) {
      // Keep the stored key, unless it belongs to a different provider.
      key =
        existing && existing.provider === provider
          ? { encryptedKey: existing.encryptedKey, wrappedKey: existing.wrappedKey, keyHint: existing.keyHint }
          : { encryptedKey: null, wrappedKey: null, keyHint: null };
    } else if (input.apiKey === null) {
      key = { encryptedKey: null, wrappedKey: null, keyHint: null };
    } else {
      const apiKey = requireString(input.apiKey, 'apiKey', 1000);
      const sealed = this.options.vault.seal(tenantId, apiKey);
      key = { encryptedKey: sealed.ciphertext, wrappedKey: sealed.wrappedKey, keyHint: keyHint(apiKey) };
    }
    if (providerNeedsKey(provider) && !key.encryptedKey) {
      throw new AiError(400, 'invalid_request', `provider ${provider} needs an apiKey`);
    }

    const data = {
      provider,
      model,
      baseUrl,
      ...key,
      redactPii: optionalBoolean(input.redactPii, 'redactPii') ?? true,
      enabled: optionalBoolean(input.enabled, 'enabled') ?? true,
      monthlyTokenCap: optionalNumber(input.monthlyTokenCap, 'monthlyTokenCap', { integer: true, min: 1 }),
      alertThreshold: optionalNumber(input.alertThreshold, 'alertThreshold', { min: 0.01, max: 1 }) ?? 0.8,
      inputCostPerMTok: optionalNumber(input.inputCostPerMTok, 'inputCostPerMTok', { min: 0 }),
      outputCostPerMTok: optionalNumber(input.outputCostPerMTok, 'outputCostPerMTok', { min: 0 }),
    };

    const row = (await this.prisma.aiProviderConfig.upsert({
      where: { tenantId_feature: { tenantId, feature } },
      create: { tenantId, feature, ...data },
      update: data,
    })) as ConfigRow;
    return { config: serializeConfig(row), created: !existing };
  }

  async deleteConfig(tenantId: string, feature: AiFeature): Promise<void> {
    const row = await this.requireConfig(tenantId, feature);
    await this.prisma.aiProviderConfig.delete({ where: { id: row.id } });
  }

  /**
   * Check that a provider, model and key work, with a tiny completion. Nothing
   * is stored or logged; the key is used for this one request.
   */
  async testKey(input: AiConfigInput): Promise<{ ok: boolean; provider: AiProviderId; model: string; latencyMs: number; error?: { code: string; message: string } }> {
    if (!isAiProviderId(input.provider)) {
      throw new AiError(400, 'invalid_request', 'provider must be one of openai, anthropic, gemini, mistral, ollama, openai_compatible');
    }
    const model = requireString(input.model, 'model', 200);
    const apiKey = input.apiKey == null ? null : requireString(input.apiKey, 'apiKey', 1000);
    const provider = createProvider({
      provider: input.provider,
      model,
      apiKey,
      baseUrl: optionalString(input.baseUrl, 'baseUrl', 500),
      allowPrivateUrls: this.options.allowPrivateUrls,
      timeoutMs: Math.min(this.options.timeoutMs ?? 60_000, 20_000),
      fetch: this.options.fetch,
    });
    const started = Date.now();
    try {
      const out = await provider.complete({ system: 'Reply with the single word: ok', prompt: 'ping', maxTokens: 16 });
      return { ok: true, provider: input.provider, model: out.model, latencyMs: Date.now() - started };
    } catch (err) {
      if (!(err instanceof AiProviderError)) throw err;
      return {
        ok: false,
        provider: input.provider,
        model,
        latencyMs: Date.now() - started,
        error: { code: err.code, message: err.message },
      };
    }
  }

  // ---- insights ------------------------------------------------------------

  async generate(tenantId: string, input: GenerateInput): Promise<InsightResult> {
    const question = input.question === undefined ? undefined : input.question.trim();
    if (question !== undefined && question.length > MAX_QUESTION) {
      throw new AiError(400, 'invalid_request', `question must be at most ${MAX_QUESTION} characters`);
    }

    const config = await this.resolveConfig(tenantId, input.kind);
    if (!config.enabled) {
      throw new AiError(409, 'ai_disabled', `AI is switched off for ${config.feature}; enable the config to use it`);
    }
    const provider = createProvider({
      provider: config.provider as AiProviderId,
      model: config.model,
      apiKey: config.encryptedKey && config.wrappedKey
        ? this.options.vault.open(tenantId, { ciphertext: config.encryptedKey, wrappedKey: config.wrappedKey })
        : null,
      baseUrl: config.baseUrl,
      allowPrivateUrls: this.options.allowPrivateUrls,
      timeoutMs: this.options.timeoutMs,
      fetch: this.options.fetch,
    });

    const context = await buildInsightContext(
      this.prisma,
      tenantId,
      input.courseId,
      this.options.heatmap ? { heatmap: this.options.heatmap } : {},
    );
    let { system, prompt } = buildPrompt(input.kind, context, question || undefined);
    let redaction = { count: 0, counts: {} as Partial<Record<PiiKind, number>> };
    if (config.redactPii) {
      const result = redactPii(prompt);
      prompt = result.text;
      redaction = { count: result.redactions, counts: result.counts };
    }
    const promptHash = createHash('sha256').update(system).update('\n').update(prompt).digest('hex');

    const base = {
      tenantId,
      configId: config.id,
      feature: config.feature,
      kind: input.kind,
      provider: config.provider,
      model: config.model,
      courseId: input.courseId ?? null,
      promptHash,
      redactions: redaction.count,
    };

    const usedBefore = await this.tokensThisMonth(config.id);
    if (config.monthlyTokenCap != null && usedBefore >= config.monthlyTokenCap) {
      await this.log({ ...base, status: 'blocked', error: 'monthly token cap reached' });
      throw new AiError(
        429,
        'ai_budget_exceeded',
        `The ${config.feature} config has used its monthly cap of ${config.monthlyTokenCap} tokens`,
      );
    }

    const started = Date.now();
    let completion;
    try {
      completion = await provider.complete({ system, prompt, maxTokens: this.options.maxOutputTokens ?? 1024 });
    } catch (err) {
      await this.log({
        ...base,
        status: 'failed',
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message.slice(0, 500) : 'unknown error',
      });
      throw err;
    }

    const costUsd = cost(config, completion.inputTokens, completion.outputTokens);
    const call = await this.log({
      ...base,
      model: completion.model,
      status: 'succeeded',
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      costUsd,
      latencyMs: Date.now() - started,
    });

    const total = completion.inputTokens + completion.outputTokens;
    this.maybeAlert(tenantId, config, usedBefore, usedBefore + total);

    return {
      id: call.id,
      kind: input.kind,
      scope: context.scope,
      courseId: input.courseId ?? null,
      feature: config.feature as AiFeature,
      provider: config.provider as AiProviderId,
      model: completion.model,
      text: completion.text,
      usage: { inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, totalTokens: total, costUsd },
      redactions: redaction,
      sample: context.sample,
      generatedAt: this.now().toISOString(),
    };
  }

  // ---- usage and audit -----------------------------------------------------

  async usage(tenantId: string): Promise<{ month: string; data: AiUsageView[] }> {
    const configs = (await this.prisma.aiProviderConfig.findMany({
      where: { tenantId },
      orderBy: { feature: 'asc' },
    })) as ConfigRow[];
    const since = this.monthStart();
    const data = await Promise.all(
      configs.map(async (c): Promise<AiUsageView> => {
        const agg = await this.prisma.aiCallLog.aggregate({
          where: { configId: c.id, createdAt: { gte: since }, status: 'succeeded' },
          _sum: { inputTokens: true, outputTokens: true, costUsd: true },
          _count: { _all: true },
        });
        const tokensUsed = (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
        return {
          feature: c.feature as AiFeature,
          provider: c.provider as AiProviderId,
          model: c.model,
          calls: agg._count._all,
          tokensUsed,
          costUsd: agg._sum.costUsd ?? null,
          monthlyTokenCap: c.monthlyTokenCap,
          alertThreshold: c.alertThreshold,
          alerting: c.monthlyTokenCap != null && tokensUsed >= c.monthlyTokenCap * c.alertThreshold,
          exhausted: c.monthlyTokenCap != null && tokensUsed >= c.monthlyTokenCap,
        };
      }),
    );
    return { month: since.toISOString().slice(0, 7), data };
  }

  async listCalls(input: {
    tenantId: string;
    limit?: number | undefined;
    before?: string | undefined;
  }): Promise<{ data: AiCallView[]; pagination: { nextCursor: string | null; hasMore: boolean } }> {
    let before: Date | undefined;
    if (input.before) {
      before = new Date(input.before);
      if (Number.isNaN(before.getTime())) throw new AiError(400, 'invalid_request', 'before must be an ISO timestamp');
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 1000);
    const rows = await this.prisma.aiCallLog.findMany({
      where: { tenantId: input.tenantId, ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(serializeCall);
    return {
      data: page,
      pagination: { nextCursor: hasMore ? page[page.length - 1]!.createdAt : null, hasMore },
    };
  }

  // ---- internals -----------------------------------------------------------

  private async requireConfig(tenantId: string, feature: AiFeature): Promise<ConfigRow> {
    const row = (await this.prisma.aiProviderConfig.findUnique({
      where: { tenantId_feature: { tenantId, feature } },
    })) as ConfigRow | null;
    if (!row) throw new AiError(404, 'ai_config_not_found', `No AI provider is configured for ${feature}`);
    return row;
  }

  /** The feature's own config, else the tenant's default. */
  private async resolveConfig(tenantId: string, kind: InsightKind): Promise<ConfigRow> {
    const rows = (await this.prisma.aiProviderConfig.findMany({
      where: { tenantId, feature: { in: [kind, 'default'] } },
    })) as ConfigRow[];
    const config = rows.find((r) => r.feature === kind) ?? rows.find((r) => r.feature === 'default');
    if (!config) {
      throw new AiError(
        404,
        'ai_not_configured',
        `No AI provider is configured for ${kind}; PUT /ai/providers/${kind} or /ai/providers/default first`,
      );
    }
    return config;
  }

  private monthStart(): Date {
    const now = this.now();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  private async tokensThisMonth(configId: string): Promise<number> {
    const agg = await this.prisma.aiCallLog.aggregate({
      where: { configId, createdAt: { gte: this.monthStart() }, status: 'succeeded' },
      _sum: { inputTokens: true, outputTokens: true },
    });
    return (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
  }

  private log(entry: {
    tenantId: string;
    configId: string;
    feature: string;
    kind: string;
    provider: string;
    model: string;
    courseId: string | null;
    promptHash: string;
    redactions: number;
    status: 'succeeded' | 'failed' | 'blocked';
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number | null;
    latencyMs?: number;
    error?: string;
  }) {
    return this.prisma.aiCallLog.create({
      data: {
        ...entry,
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
        costUsd: entry.costUsd ?? null,
        latencyMs: entry.latencyMs ?? 0,
        error: entry.error ?? null,
        createdAt: this.now(),
      },
    });
  }

  /** Publish `ai.budget.alert` when this call crossed the alert threshold or the cap. */
  private maybeAlert(tenantId: string, config: ConfigRow, before: number, after: number): void {
    const cap = config.monthlyTokenCap;
    if (cap == null || !this.options.events) return;
    const threshold = cap * config.alertThreshold;
    const level = before < cap && after >= cap ? 'exhausted' : before < threshold && after >= threshold ? 'threshold' : null;
    if (!level) return;
    this.options.events.emit(tenantId, 'ai.budget.alert', {
      level,
      feature: config.feature,
      provider: config.provider,
      model: config.model,
      tokensUsed: after,
      monthlyTokenCap: cap,
      alertThreshold: config.alertThreshold,
    });
  }
}

function cost(config: ConfigRow, input: number, output: number): number | null {
  if (config.inputCostPerMTok == null && config.outputCostPerMTok == null) return null;
  const usd = (input * (config.inputCostPerMTok ?? 0) + output * (config.outputCostPerMTok ?? 0)) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

function serializeConfig(row: ConfigRow): AiConfigView {
  return {
    feature: row.feature as AiFeature,
    provider: row.provider as AiProviderId,
    model: row.model,
    baseUrl: row.baseUrl,
    hasKey: Boolean(row.encryptedKey),
    keyHint: row.keyHint,
    redactPii: row.redactPii,
    enabled: row.enabled,
    monthlyTokenCap: row.monthlyTokenCap,
    alertThreshold: row.alertThreshold,
    inputCostPerMTok: row.inputCostPerMTok,
    outputCostPerMTok: row.outputCostPerMTok,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeCall(row: any): AiCallView {
  return {
    id: row.id,
    feature: row.feature,
    kind: row.kind,
    provider: row.provider,
    model: row.model,
    courseId: row.courseId ?? null,
    status: row.status,
    promptHash: row.promptHash,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd ?? null,
    redactions: row.redactions,
    latencyMs: row.latencyMs,
    error: row.error ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

// ---- input validation --------------------------------------------------------

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new AiError(400, 'invalid_request', `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireString(value, field, max);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new AiError(400, 'invalid_request', `${field} must be a boolean`);
  return value;
}

function optionalNumber(
  value: unknown,
  field: string,
  rule: { integer?: boolean; min?: number; max?: number },
): number | null {
  if (value === undefined || value === null) return null;
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!rule.integer || Number.isInteger(value)) &&
    (rule.min === undefined || value >= rule.min) &&
    (rule.max === undefined || value <= rule.max);
  if (!ok) {
    const range = [rule.min !== undefined ? `>= ${rule.min}` : '', rule.max !== undefined ? `<= ${rule.max}` : '']
      .filter(Boolean)
      .join(' and ');
    throw new AiError(400, 'invalid_request', `${field} must be ${rule.integer ? 'an integer' : 'a number'} ${range}`.trim());
  }
  return value;
}
