import { describe, expect, it, vi } from 'vitest';

describe('provider chain', () => {
  it('tries the same key with an extra model when the first is rate-limited', async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock('@/lib/llm/gemini', () => ({
      gemini: {
        generate: async (p: { model: string }) => {
          calls.push(p.model);
          if (p.model === 'gemini-3.1-flash-lite') {
            const { LLMError } = await import('@/lib/llm/types');
            throw new LLMError('quota', 'Daily quota used up', { provider: 'Google Gemini' });
          }
          return { text: 'ok', usage: {} };
        },
      },
    }));
    const { generateWithFallback } = await import('@/lib/llm/registry');
    const { DEFAULT_SETTINGS } = await import('@/lib/settings');
    const s = structuredClone(DEFAULT_SETTINGS);
    s.providers = [{ ...s.providers.find((p) => p.kind === 'gemini')!, apiKey: 'k', model: 'gemini-3.1-flash-lite', altModels: 'gemini-3.5-flash-lite', enabled: true }];
    const r = await generateWithFallback(s, { system: '', prompt: 'x', signal: new AbortController().signal } as never);
    expect(r.text).toBe('ok');
    expect(calls).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
  });
});
