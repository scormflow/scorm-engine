import { describe, expect, it } from 'vitest';

import {
  AiProviderError,
  createProvider,
  parseAwsCredentials,
  resolveBaseUrl,
  type AiProviderId,
} from '../../src/ai/index.js';
import { sha256Hex, signRequest } from '../../src/storage/sigv4.js';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function stubFetch(response: unknown, status = 200) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(typeof response === 'string' ? response : JSON.stringify(response), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const request = { system: 'be brief', prompt: 'hello', maxTokens: 100 };

describe('provider adapters', () => {
  it('anthropic: Messages API with x-api-key and a system prompt', async () => {
    const { fetchImpl, calls } = stubFetch({
      model: 'claude-test-1',
      content: [
        { type: 'text', text: 'Hi ' },
        { type: 'text', text: 'there' },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    const provider = createProvider({ provider: 'anthropic', model: 'claude-test', apiKey: 'sk-ant-1', fetch: fetchImpl });
    const out = await provider.complete(request);

    expect(out).toEqual({ text: 'Hi there', inputTokens: 12, outputTokens: 3, model: 'claude-test-1' });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers).toMatchObject({ 'x-api-key': 'sk-ant-1', 'anthropic-version': '2023-06-01' });
    expect(calls[0]!.body).toEqual({
      model: 'claude-test',
      max_tokens: 100,
      system: 'be brief',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('openai: Chat Completions with a bearer key and max_completion_tokens', async () => {
    const { fetchImpl, calls } = stubFetch({
      model: 'gpt-test-2026',
      choices: [{ message: { role: 'assistant', content: 'Hello' } }],
      usage: { prompt_tokens: 20, completion_tokens: 1 },
    });
    const provider = createProvider({ provider: 'openai', model: 'gpt-test', apiKey: 'sk-oa', fetch: fetchImpl });
    const out = await provider.complete(request);

    expect(out).toEqual({ text: 'Hello', inputTokens: 20, outputTokens: 1, model: 'gpt-test-2026' });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-oa');
    expect(calls[0]!.body).toMatchObject({
      model: 'gpt-test',
      max_completion_tokens: 100,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(calls[0]!.body.max_tokens).toBeUndefined();
  });

  it('gemini: generateContent with x-goog-api-key and systemInstruction', async () => {
    const { fetchImpl, calls } = stubFetch({
      candidates: [{ content: { parts: [{ text: 'Bonjour' }] } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
    });
    const provider = createProvider({ provider: 'gemini', model: 'gemini-test', apiKey: 'g-key', fetch: fetchImpl });
    const out = await provider.complete(request);

    expect(out).toEqual({ text: 'Bonjour', inputTokens: 7, outputTokens: 2, model: 'gemini-test' });
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect(calls[0]!.headers['x-goog-api-key']).toBe('g-key');
    expect(calls[0]!.body).toEqual({
      systemInstruction: { parts: [{ text: 'be brief' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { maxOutputTokens: 100 },
    });
  });

  it.each<[AiProviderId, string]>([
    ['mistral', 'https://api.mistral.ai/v1/chat/completions'],
    ['ollama', 'http://localhost:11434/v1/chat/completions'],
  ])('%s: OpenAI-compatible endpoint with max_tokens', async (id, url) => {
    const { fetchImpl, calls } = stubFetch({ choices: [{ message: { content: 'ok' } }], usage: {} });
    const provider = createProvider({
      provider: id,
      model: 'm',
      apiKey: id === 'mistral' ? 'mk' : null,
      fetch: fetchImpl,
      allowPrivateUrls: true,
    });
    const out = await provider.complete(request);
    expect(out).toEqual({ text: 'ok', inputTokens: 0, outputTokens: 0, model: 'm' });
    expect(calls[0]!.url).toBe(url);
    expect(calls[0]!.body.max_tokens).toBe(100);
    if (id === 'ollama') expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('openai_compatible: needs a baseUrl and uses it', async () => {
    expect(() => createProvider({ provider: 'openai_compatible', model: 'm' })).toThrow(/baseUrl is required/);
    const { fetchImpl, calls } = stubFetch({ choices: [{ message: { content: 'x' } }] });
    await createProvider({
      provider: 'openai_compatible',
      model: 'm',
      baseUrl: 'https://llm.example.com/v1/',
      fetch: fetchImpl,
    }).complete(request);
    expect(calls[0]!.url).toBe('https://llm.example.com/v1/chat/completions');
  });

  it('requires a key for hosted providers', () => {
    expect(() => createProvider({ provider: 'openai', model: 'm' })).toThrow(/needs an apiKey/);
    for (const id of ['groq', 'together', 'azure_openai', 'bedrock'] as const) {
      expect(() => createProvider({ provider: id, model: 'm', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' })).toThrow(
        /needs an apiKey/,
      );
    }
  });

  it.each<[AiProviderId, string]>([
    ['groq', 'https://api.groq.com/openai/v1/chat/completions'],
    ['together', 'https://api.together.xyz/v1/chat/completions'],
  ])('%s: hosted OpenAI-compatible API with a bearer key', async (id, url) => {
    const { fetchImpl, calls } = stubFetch({
      model: 'llama-test',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
    const out = await createProvider({ provider: id, model: 'llama', apiKey: 'gk', fetch: fetchImpl }).complete(request);
    expect(out).toEqual({ text: 'ok', inputTokens: 5, outputTokens: 1, model: 'llama-test' });
    expect(calls[0]!.url).toBe(url);
    expect(calls[0]!.headers.authorization).toBe('Bearer gk');
    expect(calls[0]!.body).toMatchObject({ model: 'llama', max_tokens: 100 });
  });

  it('azure_openai: v1 API under the resource endpoint, api-key header, deployment as model', async () => {
    expect(() => createProvider({ provider: 'azure_openai', model: 'd', apiKey: 'k' })).toThrow(/openai\.azure\.com/);
    const { fetchImpl, calls } = stubFetch({
      model: 'gpt-4o-2024-11-20',
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 9, completion_tokens: 1 },
    });
    const out = await createProvider({
      provider: 'azure_openai',
      model: 'my-deployment',
      apiKey: 'az-key',
      baseUrl: 'https://acme.openai.azure.com/',
      fetch: fetchImpl,
    }).complete(request);

    expect(out).toEqual({ text: 'hi', inputTokens: 9, outputTokens: 1, model: 'gpt-4o-2024-11-20' });
    expect(calls[0]!.url).toBe('https://acme.openai.azure.com/openai/v1/chat/completions');
    expect(calls[0]!.headers['api-key']).toBe('az-key');
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.body).toMatchObject({ model: 'my-deployment', max_completion_tokens: 100 });

    // An explicit API path is kept as given.
    expect(resolveBaseUrl('azure_openai', 'https://acme.openai.azure.com/openai/v1', false)).toBe(
      'https://acme.openai.azure.com/openai/v1',
    );
  });

  const converseReply = {
    output: { message: { role: 'assistant', content: [{ text: 'Hola' }, { text: '!' }] } },
    usage: { inputTokens: 14, outputTokens: 2, totalTokens: 16 },
    stopReason: 'end_turn',
  };

  it('bedrock: Converse API with a Bedrock API key as bearer token', async () => {
    const { fetchImpl, calls } = stubFetch(converseReply);
    const out = await createProvider({
      provider: 'bedrock',
      model: 'anthropic.claude-test-v1:0',
      apiKey: 'ABSKbedrockapikey',
      baseUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com',
      fetch: fetchImpl,
    }).complete(request);

    expect(out).toEqual({ text: 'Hola!', inputTokens: 14, outputTokens: 2, model: 'anthropic.claude-test-v1:0' });
    expect(calls[0]!.url).toBe('https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-test-v1%3A0/converse');
    expect(calls[0]!.headers.authorization).toBe('Bearer ABSKbedrockapikey');
    expect(calls[0]!.body).toEqual({
      system: [{ text: 'be brief' }],
      messages: [{ role: 'user', content: [{ text: 'hello' }] }],
      inferenceConfig: { maxTokens: 100 },
    });
  });

  it('bedrock: IAM credentials sign the request with SigV4 (path encoded twice)', async () => {
    const { fetchImpl, calls } = stubFetch(converseReply);
    const date = new Date('2026-10-21T08:00:00Z');
    const provider = createProvider({
      provider: 'bedrock',
      model: 'anthropic.claude-test-v1:0',
      apiKey: 'AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY:session-token-1',
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      fetch: fetchImpl,
      now: () => date,
    });
    await provider.complete(request);

    const headers = calls[0]!.headers;
    expect(headers['x-amz-date']).toBe('20261021T080000Z');
    expect(headers['x-amz-security-token']).toBe('session-token-1');
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261021\/us-east-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );

    const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', sessionToken: 'session-token-1' };
    const sign = (path: string) =>
      signRequest(
        {
          method: 'POST',
          protocol: 'https:',
          host: 'bedrock-runtime.us-east-1.amazonaws.com',
          path,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          payloadHash: sha256Hex(JSON.stringify(calls[0]!.body)),
        },
        { credentials, region: 'us-east-1', service: 'bedrock', date },
      ).headers.authorization;
    expect(headers.authorization).toBe(sign('/model/anthropic.claude-test-v1%253A0/converse'));
    expect(headers.authorization).not.toBe(sign('/model/anthropic.claude-test-v1%3A0/converse'));
  });

  it('bedrock: needs a bedrock-runtime endpoint and scrubs IAM secrets from errors', async () => {
    expect(() => createProvider({ provider: 'bedrock', model: 'm', apiKey: 'k' })).toThrow(/bedrock-runtime\.us-east-1/);
    expect(() => resolveBaseUrl('bedrock', 'https://api.example.com', false)).toThrow(/bedrock-runtime endpoint/);
    expect(resolveBaseUrl('bedrock', 'https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com', false)).toBe(
      'https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com',
    );

    const { fetchImpl } = stubFetch({ message: 'The security token included in the request is invalid: secretXYZ' }, 403);
    const err = await createProvider({
      provider: 'bedrock',
      model: 'm',
      apiKey: 'AKIAIOSFODNN7EXAMPLE:secretXYZ',
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      fetch: fetchImpl,
    })
      .complete(request)
      .catch((e) => e);
    expect(err.code).toBe('ai_provider_auth');
    expect(err.message).not.toContain('secretXYZ');
  });

  it('parseAwsCredentials tells IAM credentials from Bedrock API keys', () => {
    expect(parseAwsCredentials('AKIAIOSFODNN7EXAMPLE:abc/def+ghi')).toEqual({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'abc/def+ghi',
    });
    expect(parseAwsCredentials('ASIAIOSFODNN7EXAMPLE:s:tok==')).toMatchObject({ sessionToken: 'tok==' });
    expect(parseAwsCredentials('ABSKQmVkcm9ja0FQSUtleS1leGFtcGxl')).toBeNull();
    expect(parseAwsCredentials('bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29t')).toBeNull();
  });

  it('custom_http: POSTs the ScormFlow contract to the exact URL', async () => {
    expect(() => createProvider({ provider: 'custom_http', model: 'm' })).toThrow(/baseUrl is required/);
    const { fetchImpl, calls } = stubFetch({ text: 'done', inputTokens: 30, outputTokens: 4, model: 'in-house-7b' });
    const out = await createProvider({
      provider: 'custom_http',
      model: 'house',
      apiKey: 'gw-token',
      baseUrl: 'https://ai.example.com/v2/complete',
      fetch: fetchImpl,
    }).complete(request);

    expect(out).toEqual({ text: 'done', inputTokens: 30, outputTokens: 4, model: 'in-house-7b' });
    expect(calls[0]!.url).toBe('https://ai.example.com/v2/complete');
    expect(calls[0]!.headers.authorization).toBe('Bearer gw-token');
    expect(calls[0]!.body).toEqual({ model: 'house', system: 'be brief', prompt: 'hello', maxTokens: 100 });

    const bad = stubFetch({ answer: 'wrong shape' });
    const err = await createProvider({ provider: 'custom_http', model: 'm', baseUrl: 'https://ai.example.com', fetch: bad.fetchImpl })
      .complete(request)
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'ai_provider_error' });
    expect(bad.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('maps a 401 to ai_provider_auth and scrubs an echoed key', async () => {
    const { fetchImpl } = stubFetch({ error: { message: 'Incorrect API key provided: sk-secret-123' } }, 401);
    const provider = createProvider({ provider: 'openai', model: 'm', apiKey: 'sk-secret-123', fetch: fetchImpl });
    const err = await provider.complete(request).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.code).toBe('ai_provider_auth');
    expect(err.status).toBe(502);
    expect(err.message).toContain('[KEY]');
    expect(err.message).not.toContain('sk-secret-123');
  });

  it('maps other failures to ai_provider_error / ai_provider_unreachable', async () => {
    const { fetchImpl } = stubFetch({ message: 'overloaded' }, 529);
    const err = await createProvider({ provider: 'anthropic', model: 'm', apiKey: 'k', fetch: fetchImpl })
      .complete(request)
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'ai_provider_error', message: 'anthropic answered HTTP 529: overloaded' });

    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const err2 = await createProvider({ provider: 'anthropic', model: 'm', apiKey: 'k', fetch: down })
      .complete(request)
      .catch((e) => e);
    expect(err2).toMatchObject({ code: 'ai_provider_unreachable' });
  });
});

describe('resolveBaseUrl', () => {
  it('blocks private addresses unless allowed', () => {
    expect(() => resolveBaseUrl('ollama', null, false)).toThrow(/AI_ALLOW_PRIVATE_URLS/);
    expect(() => resolveBaseUrl('openai_compatible', 'http://169.254.169.254/v1', false)).toThrow(AiProviderError);
    expect(resolveBaseUrl('ollama', null, true)).toBe('http://localhost:11434/v1');
  });

  it('rejects non-http schemes and embedded credentials', () => {
    expect(() => resolveBaseUrl('openai_compatible', 'file:///etc/passwd', true)).toThrow(/http or https/);
    expect(() => resolveBaseUrl('openai_compatible', 'https://u:p@llm.example.com', true)).toThrow(/credentials/);
  });
});
