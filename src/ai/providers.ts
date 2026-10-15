import { isPrivateHost } from '../webhooks/urls.js';

/**
 * Bring-your-own-AI provider adapters.
 *
 * Every provider sits behind {@link AIProvider}: one `complete` call taking a
 * system prompt and a user prompt and returning text plus token usage. Adding
 * a provider means one more adapter here. Calls go out over plain `fetch` with
 * the tenant's own key; the engine never bundles or proxies a default model.
 */

export const AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'mistral', 'ollama', 'openai_compatible'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}

export interface AiCompletionRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface AiCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** The model that answered, as the provider reports it. */
  model: string;
}

export interface AIProvider {
  readonly id: AiProviderId;
  readonly model: string;
  complete(request: AiCompletionRequest): Promise<AiCompletion>;
}

export interface ProviderOptions {
  provider: AiProviderId;
  model: string;
  apiKey?: string | null;
  /** Overrides the provider's API base (required for `openai_compatible`). */
  baseUrl?: string | null;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Allow a base URL on localhost / private addresses (`AI_ALLOW_PRIVATE_URLS`). */
  allowPrivateUrls?: boolean | undefined;
}

export class AiProviderError extends Error {
  constructor(
    /** HTTP status the engine answers with. */
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

const DEFAULT_BASE_URLS: Record<AiProviderId, string | null> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  mistral: 'https://api.mistral.ai/v1',
  ollama: 'http://localhost:11434/v1',
  openai_compatible: null,
};

/** Providers that cannot be called without an API key. */
const KEY_REQUIRED: ReadonlySet<AiProviderId> = new Set(['openai', 'anthropic', 'gemini', 'mistral']);

export function providerNeedsKey(provider: AiProviderId): boolean {
  return KEY_REQUIRED.has(provider);
}

/**
 * Resolve and check the base URL a provider will be called at. Throws an
 * {@link AiProviderError} (400) for a missing, malformed or private URL.
 */
export function resolveBaseUrl(provider: AiProviderId, baseUrl: string | null | undefined, allowPrivate: boolean): string {
  const raw = baseUrl ?? DEFAULT_BASE_URLS[provider];
  if (!raw) throw new AiProviderError(400, 'invalid_request', `baseUrl is required for provider ${provider}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiProviderError(400, 'invalid_request', 'baseUrl must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AiProviderError(400, 'invalid_request', 'baseUrl must use http or https');
  }
  if (url.username || url.password) {
    throw new AiProviderError(400, 'invalid_request', 'baseUrl must not embed credentials');
  }
  if (!allowPrivate && isPrivateHost(url.hostname)) {
    throw new AiProviderError(
      400,
      'invalid_request',
      'baseUrl points at a private or loopback address; set AI_ALLOW_PRIVATE_URLS=true to allow it (e.g. for a local Ollama)',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

export function createProvider(options: ProviderOptions): AIProvider {
  const { provider, model } = options;
  if (providerNeedsKey(provider) && !options.apiKey) {
    throw new AiProviderError(400, 'invalid_request', `provider ${provider} needs an apiKey`);
  }
  const base = resolveBaseUrl(provider, options.baseUrl, options.allowPrivateUrls ?? false);
  const key = options.apiKey ?? undefined;
  const http = new ProviderHttp(provider, options.fetch ?? fetch, options.timeoutMs ?? 60_000, key);

  switch (provider) {
    case 'anthropic':
      return {
        id: provider,
        model,
        async complete(req) {
          const body = await http.post(
            `${base}/messages`,
            { 'x-api-key': key!, 'anthropic-version': '2023-06-01' },
            {
              model,
              max_tokens: req.maxTokens,
              system: req.system,
              messages: [{ role: 'user', content: req.prompt }],
            },
          );
          const text = (Array.isArray(body.content) ? body.content : [])
            .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text as string)
            .join('');
          return {
            text,
            inputTokens: num(body.usage?.input_tokens),
            outputTokens: num(body.usage?.output_tokens),
            model: typeof body.model === 'string' ? body.model : model,
          };
        },
      };

    case 'gemini':
      return {
        id: provider,
        model,
        async complete(req) {
          const body = await http.post(
            `${base}/models/${encodeURIComponent(model)}:generateContent`,
            { 'x-goog-api-key': key! },
            {
              systemInstruction: { parts: [{ text: req.system }] },
              contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
              generationConfig: { maxOutputTokens: req.maxTokens },
            },
          );
          const parts = body.candidates?.[0]?.content?.parts;
          const text = (Array.isArray(parts) ? parts : [])
            .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
            .join('');
          return {
            text,
            inputTokens: num(body.usageMetadata?.promptTokenCount),
            outputTokens: num(body.usageMetadata?.candidatesTokenCount),
            model: typeof body.modelVersion === 'string' ? body.modelVersion : model,
          };
        },
      };

    default:
      // OpenAI Chat Completions and the many APIs that copy it (Mistral, Ollama, vLLM, LM Studio, …).
      return {
        id: provider,
        model,
        async complete(req) {
          const body = await http.post(`${base}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, {
            model,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.prompt },
            ],
            // OpenAI's newer models only take max_completion_tokens; the look-alikes take max_tokens.
            ...(provider === 'openai' ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
          });
          const content = body.choices?.[0]?.message?.content;
          return {
            text: typeof content === 'string' ? content : '',
            inputTokens: num(body.usage?.prompt_tokens),
            outputTokens: num(body.usage?.completion_tokens),
            model: typeof body.model === 'string' ? body.model : model,
          };
        },
      };
  }
}

class ProviderHttp {
  constructor(
    private readonly provider: AiProviderId,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
    /** Scrubbed from error messages, in case a provider echoes it. */
    private readonly secret?: string,
  ) {}

  async post(url: string, headers: Record<string, string>, payload: unknown): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new AiProviderError(
        502,
        'ai_provider_unreachable',
        timedOut ? `${this.provider} did not answer within ${this.timeoutMs} ms` : `${this.provider} could not be reached`,
      );
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = providerMessage(text);
      if (this.secret) detail = detail.split(this.secret).join('[KEY]');
      if (res.status === 401 || res.status === 403) {
        throw new AiProviderError(502, 'ai_provider_auth', `${this.provider} rejected the API key${detail}`);
      }
      throw new AiProviderError(502, 'ai_provider_error', `${this.provider} answered HTTP ${res.status}${detail}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AiProviderError(502, 'ai_provider_error', `${this.provider} sent a response that is not JSON`);
    }
  }
}

/** The provider's own error message, if its body has one — never the request. */
function providerMessage(body: string): string {
  let message: unknown;
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message ?? parsed?.message ?? (typeof parsed?.error === 'string' ? parsed.error : undefined);
  } catch {
    return '';
  }
  return typeof message === 'string' && message ? `: ${message.slice(0, 300)}` : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}
