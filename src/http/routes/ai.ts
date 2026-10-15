import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import {
  AiError,
  AiProviderError,
  InsightContextError,
  isAiFeature,
  isInsightKind,
  KeyVaultError,
  type AiCallView,
  type AiConfigInput,
  type AiService,
} from '../../ai/index.js';

export interface AiRouteDeps {
  ai: AiService;
}

const CSV_COLUMNS: Array<keyof AiCallView> = [
  'id',
  'createdAt',
  'feature',
  'kind',
  'provider',
  'model',
  'courseId',
  'status',
  'inputTokens',
  'outputTokens',
  'costUsd',
  'redactions',
  'latencyMs',
  'promptHash',
  'error',
];

/**
 * AI analytics, mounted at `/ai` when `AI_MASTER_KEY` is set. Every route
 * needs an API key; provider keys are write-only (responses carry a hint).
 */
export function aiRoutes(deps: AiRouteDeps): FastifyPluginAsync {
  const { ai } = deps;

  return async function (app: FastifyInstance): Promise<void> {
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof AiError || err instanceof AiProviderError) {
        return reply.code(err.status).send({ code: err.code, message: err.message });
      }
      if (err instanceof InsightContextError) {
        return reply.code(404).send({ code: 'course_not_found', message: err.message });
      }
      if (err instanceof KeyVaultError) {
        req.log.error({ err }, 'AI key decryption failed');
        return reply.code(500).send({ code: 'ai_key_unreadable', message: err.message });
      }
      return reply.send(err);
    });

    const auth = { preHandler: app.requireApiKey };
    const badFeature = { code: 'invalid_request', message: 'feature must be one of default, insights, summary, recommendations' };

    app.get('/providers', auth, async (req) => ai.listConfigs(req.tenantId));

    // Registered before /providers/:feature so "test" is not read as a feature.
    app.post<{ Body: AiConfigInput }>('/providers/test', auth, async (req) => ai.testKey(req.body ?? {}));

    app.get<{ Params: { feature: string } }>('/providers/:feature', auth, async (req, reply) => {
      if (!isAiFeature(req.params.feature)) return reply.code(400).send(badFeature);
      return ai.getConfig(req.tenantId, req.params.feature);
    });

    app.put<{ Params: { feature: string }; Body: AiConfigInput }>('/providers/:feature', auth, async (req, reply) => {
      if (!isAiFeature(req.params.feature)) return reply.code(400).send(badFeature);
      const { config, created } = await ai.putConfig(req.tenantId, req.params.feature, req.body ?? {});
      reply.code(created ? 201 : 200);
      return config;
    });

    app.delete<{ Params: { feature: string } }>('/providers/:feature', auth, async (req, reply) => {
      if (!isAiFeature(req.params.feature)) return reply.code(400).send(badFeature);
      await ai.deleteConfig(req.tenantId, req.params.feature);
      return reply.code(204).send();
    });

    app.post<{ Body: { kind?: unknown; courseId?: unknown; question?: unknown } }>(
      '/insights',
      auth,
      async (req, reply) => {
        const body = req.body ?? {};
        const kind = body.kind ?? 'insights';
        if (!isInsightKind(kind)) {
          return reply
            .code(400)
            .send({ code: 'invalid_request', message: 'kind must be one of insights, summary, recommendations' });
        }
        if (body.courseId !== undefined && (typeof body.courseId !== 'string' || body.courseId === '')) {
          return reply.code(400).send({ code: 'invalid_request', message: 'courseId must be a non-empty string' });
        }
        if (body.question !== undefined && typeof body.question !== 'string') {
          return reply.code(400).send({ code: 'invalid_request', message: 'question must be a string' });
        }
        return ai.generate(req.tenantId, {
          kind,
          courseId: body.courseId as string | undefined,
          question: body.question as string | undefined,
        });
      },
    );

    app.get('/usage', auth, async (req) => ai.usage(req.tenantId));

    app.get<{ Querystring: { limit?: string; before?: string; format?: string } }>(
      '/calls',
      auth,
      async (req, reply) => {
        const { format } = req.query;
        if (format !== undefined && format !== 'json' && format !== 'csv') {
          return reply.code(400).send({ code: 'invalid_request', message: 'format must be json or csv' });
        }
        const result = await ai.listCalls({
          tenantId: req.tenantId,
          limit: req.query.limit ? Number(req.query.limit) || undefined : undefined,
          before: req.query.before,
        });
        if (format !== 'csv') return result;
        const lines = [CSV_COLUMNS.join(','), ...result.data.map((c) => CSV_COLUMNS.map((k) => csvCell(c[k])).join(','))];
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="ai-calls.csv"')
          .header('x-next-cursor', result.pagination.nextCursor ?? '')
          .send(`${lines.join('\n')}\n`);
      },
    );
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Keep spreadsheet apps from evaluating a cell as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
