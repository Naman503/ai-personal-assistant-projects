/**
 * Google Gemini (Generative Language API, v1beta generateContent / streamGenerateContent).
 *
 * Version differences handled here:
 *  - 3.x models use `thinkingConfig.thinkingLevel`; 2.5 Flash uses `thinkingBudget: 0`;
 *    2.5 Pro can't disable thinking. Sending the wrong one returns 400, so we
 *    progressively relax the request: thinking → schema → plain.
 *  - Google recommends the default temperature (1.0) for 3.x models, so we only send
 *    a custom temperature to older models.
 */

import type { ProviderConfig } from '../settings';
import { LLMError, type LLMRequest, type LLMResult, type ProviderAdapter } from './types';
import { httpError, joinUrl, readSSE, safeFetch } from './http';
import { createLogger } from '../logger';

const log = createLogger('bg:gemini');
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const NAME = 'Gemini';

type Variant = { thinking: boolean; schema: boolean; json: boolean };

function thinkingConfig(model: string, level: LLMRequest['thinking']): Record<string, unknown> | undefined {
  const m = model.toLowerCase();
  if (/gemini-2\.5-pro/.test(m)) return undefined;
  if (/gemini-2\.5/.test(m)) return level === 'off' ? { thinkingBudget: 0 } : { thinkingBudget: level === 'low' ? 512 : level === 'medium' ? 2048 : 8192 };
  if (/gemini-[3-9]/.test(m)) {
    // Lite models support "minimal"; Flash 3.7+/3.8 lowest is "low". The relaxation loop handles 400s.
    return { thinkingLevel: level === 'off' ? (/lite/.test(m) ? 'minimal' : 'low') : level };
  }
  return undefined;
}

function buildBody(req: LLMRequest, model: string, v: Variant) {
  const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxTokens };
  if (!/gemini-[3-9]/.test(model)) generationConfig.temperature = req.temperature;
  if (v.json) generationConfig.responseMimeType = 'application/json';
  if (v.json && v.schema && req.schema) generationConfig.responseJsonSchema = req.schema;
  const tc = v.thinking ? thinkingConfig(model, req.thinking) : undefined;
  if (tc) generationConfig.thinkingConfig = tc;
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    generationConfig,
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
}

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; code?: number };
}

function chunkText(c: GeminiChunk): string {
  return (c.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

function checkBlocked(c: GeminiChunk) {
  if (c.error) throw new LLMError('bad-response', c.error.message ?? 'Gemini error', { provider: NAME });
  if (c.promptFeedback?.blockReason)
    throw new LLMError('blocked', `Gemini blocked the prompt (${c.promptFeedback.blockReason}).`, { provider: NAME });
  const fr = c.candidates?.[0]?.finishReason;
  if (fr && ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(fr))
    throw new LLMError('blocked', `Gemini stopped the answer (${fr}).`, { provider: NAME, retryable: false });
}

async function once(cfg: ProviderConfig, req: LLMRequest, v: Variant): Promise<LLMResult> {
  const base = cfg.baseUrl || DEFAULT_BASE;
  const model = cfg.model.replace(/^models\//, '');
  const url = joinUrl(base, `models/${encodeURIComponent(model)}:${req.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`);
  const res = await safeFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey.trim() },
      body: JSON.stringify(buildBody(req, model, v)),
      signal: req.signal,
    },
    NAME,
  );
  if (!res.ok) throw await httpError(res, NAME);

  let text = '';
  let usage: LLMResult['usage'];
  if (req.stream) {
    await readSSE(
      res,
      (data) => {
        const c = JSON.parse(data) as GeminiChunk;
        checkBlocked(c);
        const t = chunkText(c);
        if (t) {
          text += t;
          req.onText?.(text);
        }
        if (c.usageMetadata) usage = { input: c.usageMetadata.promptTokenCount, output: c.usageMetadata.candidatesTokenCount };
      },
      req.signal,
    );
  } else {
    const c = (await res.json()) as GeminiChunk;
    checkBlocked(c);
    text = chunkText(c);
    req.onText?.(text);
    if (c.usageMetadata) usage = { input: c.usageMetadata.promptTokenCount, output: c.usageMetadata.candidatesTokenCount };
  }
  return { text, model, usage };
}

export const gemini: ProviderAdapter = {
  async generate(cfg, req) {
    if (!cfg.apiKey.trim()) throw new LLMError('auth', 'No Gemini API key set.', { provider: NAME, hint: 'Get a free key at aistudio.google.com/app/apikey' });
    const variants: Variant[] = [
      { thinking: true, schema: true, json: true },
      { thinking: false, schema: true, json: true },
      { thinking: false, schema: false, json: true },
      { thinking: false, schema: false, json: false },
    ];
    let last: unknown;
    for (const v of variants) {
      try {
        return await once(cfg, req, v);
      } catch (e) {
        last = e;
        // Only "invalid argument" style 400s are worth relaxing; everything else bubbles up.
        if (!(e instanceof LLMError) || e.status !== 400 || e.code === 'auth') throw e;
        log.warn(`request rejected with 400, relaxing request (${JSON.stringify(v)})`, e.message);
      }
    }
    throw last;
  },

  async listModels(cfg, signal) {
    const base = cfg.baseUrl || DEFAULT_BASE;
    const res = await safeFetch(joinUrl(base, 'models?pageSize=200'), { headers: { 'x-goog-api-key': cfg.apiKey.trim() }, signal }, NAME);
    if (!res.ok) throw await httpError(res, NAME);
    type GM = { name: string; displayName?: string; description?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[]; thinking?: boolean };
    const all: GM[] = [];
    let pageToken = '';
    // The list is paginated; follow nextPageToken so every model shows up.
    for (let i = 0; i < 10; i++) {
      const url = joinUrl(base, `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      const res = await safeFetch(url, { headers: { 'x-goog-api-key': cfg.apiKey.trim() }, signal }, NAME);
      if (!res.ok) throw await httpError(res, NAME);
      const j = (await res.json()) as { models?: GM[]; nextPageToken?: string };
      all.push(...(j.models ?? []));
      if (!j.nextPageToken) break;
      pageToken = j.nextPageToken;
    }
    return all
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => ({
        id: m.name.replace(/^models\//, ''),
        name: m.displayName,
        description: m.description,
        context: m.inputTokenLimit,
        maxOutput: m.outputTokenLimit,
        thinking: m.thinking,
        owner: 'Google',
      }))
      .filter((m) => /gemini|gemma/.test(m.id) && !/image|tts|audio|live|embedding|veo|imagen|robotics|computer-use/.test(m.id))
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  },

  async embed(cfg, texts, model, signal) {
    const base = cfg.baseUrl || DEFAULT_BASE;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const res = await safeFetch(
        joinUrl(base, `models/${model}:batchEmbedContents`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey.trim() },
          body: JSON.stringify({
            requests: batch.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t }] }, outputDimensionality: 768 })),
          }),
          signal,
        },
        NAME,
      );
      if (!res.ok) throw await httpError(res, NAME);
      const j = (await res.json()) as { embeddings?: { values: number[] }[] };
      for (const e of j.embeddings ?? []) out.push(e.values);
    }
    return out;
  },
};
