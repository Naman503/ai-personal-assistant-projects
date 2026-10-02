import { afterEach, describe, expect, it, vi } from 'vitest';
import { readNDJSON, readSSE, httpError, parseRetryAfter } from '@/lib/llm/http';
import { gemini } from '@/lib/llm/gemini';
import { openai } from '@/lib/llm/openai';
import { ollama, ollamaOriginRule } from '@/lib/llm/ollama';
import { generateWithFallback, resetCooldowns } from '@/lib/llm/registry';
import { LLMError, type LLMRequest } from '@/lib/llm/types';
import { DEFAULTS, providerFromPreset } from '@/lib/settings-core';

const enc = new TextEncoder();
function streamRes(chunks: string[], init: ResponseInit = {}) {
  const body = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });

const req = (p: Partial<LLMRequest> = {}): LLMRequest => ({
  system: 'sys',
  prompt: 'hello',
  temperature: 0.5,
  maxTokens: 100,
  thinking: 'off',
  stream: false,
  signal: new AbortController().signal,
  ...p,
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCooldowns();
});

describe('stream readers', () => {
  it('SSE across chunk boundaries and CRLF', async () => {
    const got: string[] = [];
    await readSSE(streamRes(['data: {"a":1}\r\n\r\nda', 'ta: {"a":2}\n\n', ': comment\n\n', 'data: [DONE]\n\n']), (d) => got.push(d));
    expect(got).toEqual(['{"a":1}', '{"a":2}', '[DONE]']);
  });
  it('NDJSON across chunk boundaries', async () => {
    const got: unknown[] = [];
    await readNDJSON(streamRes(['{"x":1}\n{"x"', ':2}\n']), (o) => got.push(o));
    expect(got).toEqual([{ x: 1 }, { x: 2 }]);
  });
  it('error mapping', async () => {
    expect((await httpError(json({ error: { message: 'API key not valid' } }, 400), 'Gemini')).code).toBe('auth');
    const rl = await httpError(json({ error: 'slow down' }, 429, { 'retry-after': '3' }), 'Groq');
    expect(rl.code).toBe('rate-limit');
    expect(rl.retryable).toBe(true);
    expect(rl.retryAfterMs).toBe(3000);
    expect((await httpError(new Response('forbidden', { status: 403 }), 'Ollama')).code).toBe('cors');
    expect((await httpError(new Response('x', { status: 503 }), 'X')).retryable).toBe(true);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('gemini adapter', () => {
  const cfg = { ...providerFromPreset('gemini'), apiKey: 'k' };

  it('sends key header, system prompt, JSON schema and thinking config (3.x)', async () => {
    const fetchMock = vi.fn(async () => json({ candidates: [{ content: { parts: [{ text: '{"suggestions":[]}' }] } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await gemini.generate(cfg, req({ schema: { type: 'object' } }));
    expect(r.text).toBe('{"suggestions":[]}');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/gemini-3.5-flash-lite:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.generationConfig.responseJsonSchema).toEqual({ type: 'object' });
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    expect(body.generationConfig.temperature).toBeUndefined();
  });

  it('uses thinkingBudget 0 + temperature on 2.5 flash', async () => {
    const fetchMock = vi.fn(async () => json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await gemini.generate({ ...cfg, model: 'gemini-2.5-flash' }, req());
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(body.generationConfig.temperature).toBe(0.5);
  });

  it('relaxes the request on 400 invalid-argument errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { message: 'thinking level not supported' } }, 400))
      .mockResolvedValueOnce(json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await gemini.generate(cfg, req());
    expect(r.text).toBe('ok');
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body2.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('streams SSE, skips thought parts, reports progress', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamRes([
          'data: {"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n',
        ]),
      ),
    );
    const seen: string[] = [];
    const r = await gemini.generate(cfg, req({ stream: true, onText: (t) => seen.push(t) }));
    expect(r.text).toBe('Hello');
    expect(seen).toEqual(['Hel', 'Hello']);
    expect(r.usage).toEqual({ input: 5, output: 2 });
  });

  it('throws blocked on safety stops and auth without key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ candidates: [{ finishReason: 'SAFETY' }] })));
    await expect(gemini.generate(cfg, req())).rejects.toMatchObject({ code: 'blocked' });
    await expect(gemini.generate({ ...cfg, apiKey: '' }, req())).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('openai-compatible adapter', () => {
  const cfg = { ...providerFromPreset('groq'), apiKey: 'gk' };
  it('streams chat completions and strips <think>', async () => {
    const fetchMock = vi.fn(async () =>
      streamRes(['data: {"choices":[{"delta":{"content":"<think>hmm</think>Hi"}}]}\n\n', 'data: {"choices":[{"delta":{"content":" there"}}]}\n\n', 'data: [DONE]\n\n']),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await openai.generate(cfg, req({ stream: true }));
    expect(r.text).toBe('Hi there');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gk');
    expect(JSON.parse(init.body as string).response_format).toEqual({ type: 'json_object' });
  });
  it('retries without response_format when rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { message: 'response_format json_object is not supported' } }, 400))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'plain' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await openai.generate(cfg, req());
    expect(r.text).toBe('plain');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).response_format).toBeUndefined();
  });
  it('lists models free-first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 'b' }, { id: 'a:free' }, { id: 'c' }] })));
    expect((await openai.listModels(cfg)).map((m) => m.id)).toEqual(['a:free', 'b', 'c']);
  });
  it('maps OpenRouter pricing/context and Groq context_window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          data: [
            { id: 'x/paid', name: 'Paid', context_length: 128000, pricing: { prompt: '0.0000001', completion: '0.0000004' } },
            { id: 'y/zero', context_window: 8192, owned_by: 'Meta', pricing: { prompt: '0', completion: '0' } },
            { id: 'whisper-large-v3' },
          ],
        }),
      ),
    );
    const list = await openai.listModels(cfg);
    expect(list.map((m) => m.id)).toEqual(['y/zero', 'x/paid']);
    expect(list[0]).toMatchObject({ free: true, context: 8192, owner: 'Meta' });
    expect(list[1].price?.input).toBeCloseTo(0.1);
    expect(list[1].price?.output).toBeCloseTo(0.4);
  });
});

describe('ollama adapter', () => {
  it('reads NDJSON stream and sends format schema', async () => {
    const fetchMock = vi.fn(async () => streamRes(['{"message":{"content":"A"},"done":false}\n', '{"message":{"content":"B"},"done":true}\n']));
    vi.stubGlobal('fetch', fetchMock);
    const r = await ollama.generate(providerFromPreset('ollama'), req({ stream: true, schema: { type: 'object' } }));
    expect(r.text).toBe('AB');
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).format).toEqual({ type: 'object' });
  });
  it('maps connection refused to a helpful network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(ollama.generate(providerFromPreset('ollama'), req())).rejects.toMatchObject({ code: 'network', retryable: false });
  });
  it('builds a narrowly scoped Origin-removal rule', () => {
    const rule = ollamaOriginRule('http://localhost:11434/', 'extid', 7)!;
    expect(rule.condition).toMatchObject({ urlFilter: '|http://localhost:11434/', initiatorDomains: ['extid'] });
    expect(rule.condition.tabIds).toBeUndefined();
    expect(rule.action.requestHeaders?.[0]).toMatchObject({ header: 'origin', operation: 'remove' });
    expect(ollamaOriginRule('not a url', 'x')).toBeNull();
  });
});

describe('provider chain', () => {
  const settings = () => {
    const s = structuredClone(DEFAULTS);
    s.providers = [
      { ...providerFromPreset('groq'), apiKey: 'a' },
      { ...providerFromPreset('openrouter'), apiKey: 'b' },
    ];
    s.generation.maxRetries = 1;
    return s;
  };

  it('falls back to the next provider on auth errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { message: 'Invalid API Key' } }, 401))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'from openrouter' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await generateWithFallback(settings(), req());
    expect(r.text).toBe('from openrouter');
    expect(r.provider.id).toBe('openrouter');
    expect(r.attempts[0].error).toMatch(/^auth/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // auth is not retried
  });

  it('retries retryable errors with short Retry-After', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'busy' }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await generateWithFallback(settings(), req());
    expect(r.provider.id).toBe('groq');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws no-provider when nothing is configured, honours local-only', async () => {
    const s = settings();
    s.providers = s.providers.map((p) => ({ ...p, apiKey: '' }));
    await expect(generateWithFallback(s, req())).rejects.toMatchObject({ code: 'no-provider' });
    const s2 = settings();
    s2.privacy.localOnly = true;
    await expect(generateWithFallback(s2, req())).rejects.toBeInstanceOf(LLMError);
  });

  it('propagates aborts without falling back', async () => {
    const ctl = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        ctl.abort();
        throw new DOMException('Aborted', 'AbortError');
      }),
    );
    await expect(generateWithFallback(settings(), req({ signal: ctl.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });
});
