/**
 * OpenAI-compatible /chat/completions. Covers OpenRouter, Groq, LM Studio,
 * OpenAI, Mistral, Together, DeepSeek, Cerebras and others.
 */

import type { ProviderConfig } from '../settings';
import { LLMError, type LLMRequest, type LLMResult, type ProviderAdapter } from './types';
import { httpError, joinUrl, readSSE, safeFetch } from './http';
import { createLogger } from '../logger';

const log = createLogger('bg:openai');

function headers(cfg: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...cfg.headers };
  if (cfg.apiKey.trim()) h.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  return h;
}

interface ChatChunk {
  choices?: { delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number | string };
  model?: string;
}

async function once(cfg: ProviderConfig, req: LLMRequest, json: boolean): Promise<LLMResult> {
  const name = cfg.label || 'OpenAI-compatible';
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.prompt },
    ],
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    stream: req.stream,
  };
  if (json) body.response_format = { type: 'json_object' };
  const res = await safeFetch(
    joinUrl(cfg.baseUrl, 'chat/completions'),
    { method: 'POST', headers: headers(cfg), body: JSON.stringify(body), signal: req.signal },
    name,
  );
  if (!res.ok) throw await httpError(res, name);

  let text = '';
  let usage: LLMResult['usage'];
  let model = cfg.model;
  if (req.stream) {
    await readSSE(
      res,
      (data) => {
        if (data === '[DONE]') return;
        let c: ChatChunk;
        try {
          c = JSON.parse(data);
        } catch {
          return; // OpenRouter sends ": OPENROUTER PROCESSING" comments; non-JSON keep-alives are ignored
        }
        if (c.error) throw new LLMError('bad-response', c.error.message ?? 'Stream error', { provider: name, retryable: true });
        const t = c.choices?.[0]?.delta?.content;
        if (t) {
          text += t;
          req.onText?.(text);
        }
        if (c.model) model = c.model;
        if (c.usage) usage = { input: c.usage.prompt_tokens, output: c.usage.completion_tokens };
      },
      req.signal,
    );
  } else {
    const c = (await res.json()) as ChatChunk;
    if (c.error) throw new LLMError('bad-response', c.error.message ?? 'Error', { provider: name });
    text = c.choices?.[0]?.message?.content ?? '';
    if (c.model) model = c.model;
    req.onText?.(text);
  }
  // Reasoning models sometimes leak <think> blocks into content.
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  return { text, model, usage };
}

export const openai: ProviderAdapter = {
  async generate(cfg, req) {
    if (!cfg.baseUrl) throw new LLMError('no-provider', 'Base URL is empty.', { provider: cfg.label });
    if (!cfg.model) throw new LLMError('no-provider', 'No model selected.', { provider: cfg.label, hint: 'Pick a model in settings.' });
    try {
      return await once(cfg, req, cfg.jsonMode);
    } catch (e) {
      // Many free models reject response_format: retry once without it.
      if (cfg.jsonMode && e instanceof LLMError && e.status === 400 && /response_format|json|not supported|unsupported/i.test(e.message)) {
        log.warn('provider rejected JSON mode; retrying without response_format', e.message);
        return once(cfg, req, false);
      }
      throw e;
    }
  },

  async listModels(cfg, signal) {
    const res = await safeFetch(joinUrl(cfg.baseUrl, 'models'), { headers: headers(cfg), signal }, cfg.label);
    if (!res.ok) throw await httpError(res, cfg.label);
    type OM = {
      id: string;
      name?: string;
      description?: string;
      context_length?: number;
      context_window?: number;
      owned_by?: string;
      active?: boolean;
      pricing?: { prompt?: string | number; completion?: string | number };
      top_provider?: { max_completion_tokens?: number | null };
      max_completion_tokens?: number;
    };
    const j = (await res.json()) as { data?: OM[] };
    const perM = (v: string | number | undefined) => (v === undefined || v === null || v === '' ? undefined : Number(v) * 1_000_000);
    return (j.data ?? [])
      .filter((m) => m.active !== false && !/whisper|tts|embed|guard|moderation|image|dall-e|audio|transcribe/i.test(m.id))
      .map((m) => {
        const input = perM(m.pricing?.prompt);
        const output = perM(m.pricing?.completion);
        return {
          id: m.id,
          name: m.name,
          description: m.description,
          context: m.context_length ?? m.context_window,
          maxOutput: m.top_provider?.max_completion_tokens ?? m.max_completion_tokens ?? undefined,
          owner: m.owned_by ?? m.id.split('/')[0],
          price: input !== undefined && output !== undefined ? { input, output } : undefined,
          free: m.id.endsWith(':free') || m.id === 'openrouter/free' || (input === 0 && output === 0) || undefined,
        };
      })
      // Free models first, then alphabetical.
      .sort((a, b) => Number(!!b.free) - Number(!!a.free) || a.id.localeCompare(b.id));
  },
};
