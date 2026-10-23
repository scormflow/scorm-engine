import { describe, expect, it } from 'vitest';

import { AiProviderError, createProvider, resolveBaseUrl, type AiProviderId } from '../../src/ai/index.js';

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
