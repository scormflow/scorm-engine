import { sha256Hex, signRequest, uriEncode, type SigV4Credentials } from '../storage/sigv4.js';
import { isPrivateHost } from '../webhooks/urls.js';

/**
 * Bring-your-own-AI provider adapters.
 *
 * Every provider sits behind {@link AIProvider}: one `complete` call taking a
 * system prompt and a user prompt and returning text plus token usage. Adding
 * a provider means one more adapter here. Calls go out over plain `fetch` with
 * the tenant's own key; the engine never bundles or proxies a default model.
 */

export const AI_PROVIDERS = [
  'openai',
  'anthropic',
  'gemini',
  'mistral',
  'ollama',
  'openai_compatible',
  'groq',
  'together',
  'azure_openai',
  'bedrock',
  'custom_http',
] as const;
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
  /**
   * Overrides the provider's API base. Required for `openai_compatible`,
   * `azure_openai` (the resource endpoint), `bedrock` (the regional
   * `bedrock-runtime` endpoint) and `custom_http` (the exact URL to POST to).
   */
  baseUrl?: string | null;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Clock for request signing (Bedrock with IAM credentials). */
  now?: (() => Date) | undefined;
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
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  // Per-resource / per-region endpoints: the tenant has to say which one.
  azure_openai: null,
  bedrock: null,
  custom_http: null,
};

const BASE_URL_EXAMPLES: Partial<Record<AiProviderId, string>> = {
  openai_compatible: 'https://llm.example.com/v1',
  azure_openai: 'https://<resource>.openai.azure.com',
  bedrock: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  custom_http: 'https://ai.example.com/complete',
};

/** Providers that cannot be called without an API key. */
const KEY_REQUIRED: ReadonlySet<AiProviderId> = new Set([
  'openai',
  'anthropic',
  'gemini',
  'mistral',
  'groq',
  'together',
  'azure_openai',
  'bedrock',
]);

export function providerNeedsKey(provider: AiProviderId): boolean {
  return KEY_REQUIRED.has(provider);
}

/**
 * Resolve and check the base URL a provider will be called at. Throws an
 * {@link AiProviderError} (400) for a missing, malformed or private URL.
 */
export function resolveBaseUrl(provider: AiProviderId, baseUrl: string | null | undefined, allowPrivate: boolean): string {
  const raw = baseUrl ?? DEFAULT_BASE_URLS[provider];
  if (!raw) {
    const example = BASE_URL_EXAMPLES[provider];
    throw new AiProviderError(
      400,
      'invalid_request',
      `baseUrl is required for provider ${provider}${example ? ` (e.g. ${example})` : ''}`,
    );
  }
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
  if (provider === 'azure_openai' && url.pathname === '/') {
    // A bare resource endpoint, as the Azure portal shows it: use the v1 API under it.
    url.pathname = '/openai/v1';
  }
  if (provider === 'bedrock') bedrockRegion(url.hostname);
  return url.toString().replace(/\/+$/, '');
}

/** The AWS region in a `bedrock-runtime` endpoint (public, FIPS or VPC-endpoint form). */
function bedrockRegion(hostname: string): string {
  const match = /(?:^|\.)bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.(?:vpce\.)?amazonaws\.com(?:\.cn)?$/.exec(hostname);
  if (!match) {
    throw new AiProviderError(
      400,
      'invalid_request',
      'baseUrl for bedrock must be a bedrock-runtime endpoint, e.g. https://bedrock-runtime.us-east-1.amazonaws.com',
    );
  }
  return match[1]!;
}

/**
 * Bedrock takes either a Bedrock API key (sent as a bearer token) or IAM
 * credentials written as `ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]`,
 * which sign each request with SigV4.
 */
export function parseAwsCredentials(apiKey: string): SigV4Credentials | null {
  const match = /^((?:AKIA|ASIA)[A-Z0-9]{12,}):([^:\s]+)(?::(\S+))?$/.exec(apiKey.trim());
  if (!match) return null;
  return { accessKeyId: match[1]!, secretAccessKey: match[2]!, ...(match[3] ? { sessionToken: match[3] } : {}) };
}

export function createProvider(options: ProviderOptions): AIProvider {
  const { provider, model } = options;
  if (providerNeedsKey(provider) && !options.apiKey) {
    throw new AiProviderError(400, 'invalid_request', `provider ${provider} needs an apiKey`);
  }
  const base = resolveBaseUrl(provider, options.baseUrl, options.allowPrivateUrls ?? false);
  const key = options.apiKey ?? undefined;
  const aws = provider === 'bedrock' && key ? parseAwsCredentials(key) : null;
  const secrets = aws ? [key!, aws.secretAccessKey, ...(aws.sessionToken ? [aws.sessionToken] : [])] : key ? [key] : [];
  const http = new ProviderHttp(provider, options.fetch ?? fetch, options.timeoutMs ?? 60_000, secrets);

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

    case 'bedrock': {
      const now = options.now ?? (() => new Date());
      return {
        id: provider,
        model,
        async complete(req) {
          // Converse API: one request shape for every model family on Bedrock.
          const url = new URL(`${base}/model/${uriEncode(model)}/converse`);
          const payload = {
            system: [{ text: req.system }],
            messages: [{ role: 'user', content: [{ text: req.prompt }] }],
            inferenceConfig: { maxTokens: req.maxTokens },
          };
          let headers: Record<string, string>;
          if (aws) {
            // Non-S3 services sign the path URI-encoded twice (a model id's `:` becomes %253A).
            headers = signRequest(
              {
                method: 'POST',
                protocol: url.protocol,
                host: url.host,
                path: url.pathname.split('/').map(uriEncode).join('/'),
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                payloadHash: sha256Hex(JSON.stringify(payload)),
              },
              { credentials: aws, region: bedrockRegion(url.hostname), service: 'bedrock', date: now() },
            ).headers;
          } else {
            headers = { authorization: `Bearer ${key}` };
          }
          const body = await http.post(url.toString(), headers, payload);
          const content = body.output?.message?.content;
          const text = (Array.isArray(content) ? content : [])
            .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
            .join('');
          return {
            text,
            inputTokens: num(body.usage?.inputTokens),
            outputTokens: num(body.usage?.outputTokens),
            model,
          };
        },
      };
    }

    case 'custom_http':
      // ScormFlow's own minimal contract, for an AI gateway or in-house service.
      return {
        id: provider,
        model,
        async complete(req) {
          const body = await http.post(base, key ? { authorization: `Bearer ${key}` } : {}, {
            model,
            system: req.system,
            prompt: req.prompt,
            maxTokens: req.maxTokens,
          });
          if (typeof body?.text !== 'string') {
            throw new AiProviderError(502, 'ai_provider_error', 'custom_http answered without a string "text" field');
          }
          return {
            text: body.text,
            inputTokens: num(body.inputTokens),
            outputTokens: num(body.outputTokens),
            model: typeof body.model === 'string' ? body.model : model,
          };
        },
      };

    default:
      // OpenAI Chat Completions and the many APIs that copy it (Mistral, Groq, Together, Ollama, vLLM, …).
      return {
        id: provider,
        model,
        async complete(req) {
          // Azure OpenAI takes its key in `api-key`, and `model` is the deployment name.
          const auth: Record<string, string> = !key
            ? {}
            : provider === 'azure_openai'
              ? { 'api-key': key }
              : { authorization: `Bearer ${key}` };
          const body = await http.post(`${base}/chat/completions`, auth, {
            model,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.prompt },
            ],
            // OpenAI's newer models only take max_completion_tokens; the look-alikes take max_tokens.
            ...(provider === 'openai' || provider === 'azure_openai' ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
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
    /** Scrubbed from error messages, in case a provider echoes one. */
    private readonly secrets: readonly string[] = [],
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
      for (const secret of this.secrets) detail = detail.split(secret).join('[KEY]');
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
