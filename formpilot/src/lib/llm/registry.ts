/**
 * Provider chain with retries and automatic fallback.
 *
 *  - Providers are tried in the user's order. Disabled or unconfigured ones are skipped.
 *  - Retryable errors (429, 5xx, network) back off exponentially, honouring Retry-After when it's short.
 *  - Non-retryable errors (bad key, blocked, model not found) move straight to the next provider.
 *  - "Local only" mode restricts the chain to on-device providers.
 */

import { isLocalProvider, providerConfigured, type ProviderConfig, type Settings } from '../settings';
import { LLMError, type LLMRequest, type LLMResult, type ProviderAdapter } from './types';
import { gemini } from './gemini';
import { openai } from './openai';
import { ollama } from './ollama';
import { chromeAi, chromeAiAvailability } from './chrome-ai';
import { isAbort, sleep } from '../util';
import { createLogger } from '../logger';

const log = createLogger('bg:llm');

export const ADAPTERS: Record<ProviderConfig['kind'], ProviderAdapter> = {
  gemini,
  openai,
  ollama,
  'chrome-ai': chromeAi,
};

export function adapterFor(p: ProviderConfig): ProviderAdapter {
  return ADAPTERS[p.kind];
}

/** Providers that will be tried, in order. */
export function activeProviders(s: Settings): ProviderConfig[] {
  return s.providers.filter((p) => providerConfigured(p) && (!s.privacy.localOnly || isLocalProvider(p)));
}

/** Providers that recently failed hard (bad key, unavailable) are skipped for a while. */
const cooldown = new Map<string, number>();
export function resetCooldowns() {
  cooldown.clear();
}

export interface ChainResult extends LLMResult {
  provider: ProviderConfig;
  attempts: { provider: string; error?: string; ms: number }[];
}

export async function generateWithFallback(s: Settings, req: LLMRequest, only?: string): Promise<ChainResult> {
  const chain = only ? s.providers.filter((p) => p.id === only) : activeProviders(s);
  if (!chain.length) {
    throw new LLMError('no-provider', 'No AI provider is configured.', {
      hint: s.privacy.localOnly
        ? 'Local-only mode is on: enable Chrome AI or Ollama in settings.'
        : 'Open FormPilot settings → Providers and add a free Gemini / OpenRouter / Groq key, or enable Chrome AI or Ollama.',
    });
  }
  const attempts: ChainResult['attempts'] = [];
  let lastErr: unknown;
  const tryList = s.generation.fallback || only ? chain : chain.slice(0, 1);

  for (const p of tryList) {
    const until = cooldown.get(p.id);
    if (!only && until && until > Date.now() && tryList.length > 1) {
      log.debug(`skipping ${p.label} (cooling down for ${Math.round((until - Date.now()) / 1000)}s)`);
      continue;
    }
    if (p.kind === 'chrome-ai') {
      const status = await chromeAiAvailability();
      if (status !== 'available') {
        log.debug(`skipping ${p.label}: ${status}`);
        lastErr ??= new LLMError('unavailable', status === 'no-api' ? 'Chrome built-in AI is not available in this browser.' : `Gemini Nano is ${status}.`, {
          provider: p.label,
          hint: status === 'downloadable' ? 'Download it in Settings → AI Providers → Chrome AI.' : 'Use another provider (Gemini key, Groq, OpenRouter, Ollama).',
        });
        continue;
      }
    }
    for (let attempt = 0; attempt <= s.generation.maxRetries; attempt++) {
      const t0 = performance.now();
      try {
        log.info(`→ ${p.label} · ${p.model}${attempt ? ` (retry ${attempt})` : ''}`);
        const r = await adapterFor(p).generate(p, req);
        const ms = Math.round(performance.now() - t0);
        attempts.push({ provider: p.label, ms });
        log.info(`← ${p.label} answered in ${ms}ms (${r.text.length} chars)`, r.usage);
        cooldown.delete(p.id);
        return { ...r, provider: p, attempts };
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        if (isAbort(e) || req.signal.aborted) throw e;
        lastErr = e;
        const err = e instanceof LLMError ? e : new LLMError('unknown', (e as Error)?.message ?? String(e), { provider: p.label });
        err.provider ??= p.label;
        attempts.push({ provider: p.label, error: `${err.code}: ${err.message}`, ms });
        // Info, not warn: falling back is normal. The engine logs a real error only if the whole chain fails.
        log.info(`✗ ${p.label} failed [${err.code}] after ${ms}ms: ${err.message}`);
        if (['auth', 'cors', 'no-provider'].includes(err.code)) {
          cooldown.set(p.id, Date.now() + 5 * 60_000);
        } else if (err.code === 'unavailable' && p.kind === 'chrome-ai') {
          cooldown.set(p.id, Date.now() + 10 * 60_000);
        }
        if (!err.retryable || attempt >= s.generation.maxRetries) break;
        const wait = err.retryAfterMs ?? 600 * 2 ** attempt + Math.random() * 300;
        if (wait > 8000) {
          if (err.code === 'rate-limit') cooldown.set(p.id, Date.now() + wait);
          break; // too long: fall through to the next provider
        }
        await sleep(wait, req.signal);
      }
    }
  }
  if (lastErr instanceof LLMError) throw lastErr;
  throw new LLMError('unknown', (lastErr as Error)?.message ?? 'All providers failed.');
}
