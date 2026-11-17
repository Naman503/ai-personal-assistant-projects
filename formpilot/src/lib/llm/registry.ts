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
import { resolveStoredKey, VaultLockedError } from '../vault';
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

/**
 * Fill in a provider's API key from the encrypted vault (keys are never kept in settings).
 * Throws an LLMError('locked') when the vault is locked (strict mode, before the user unlocks).
 */
export async function resolveProvider(p: ProviderConfig): Promise<ProviderConfig> {
  if (p.apiKey.trim() || !p.hasKey) return p;
  try {
    const key = await resolveStoredKey(p.id);
    return key ? { ...p, apiKey: key } : p;
  } catch (e) {
    if (e instanceof VaultLockedError) {
      throw new LLMError('locked', 'FormPilot is locked.', { provider: p.label, hint: 'Enter your FormPilot password once to use your saved API keys.' });
    }
    throw new LLMError('auth', `Could not read the saved key: ${(e as Error).message}`, { provider: p.label, hint: 'Re-enter the API key in settings.' });
  }
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

/** Recent request times per provider+model, to stay under a requests-per-minute limit. */
const recent = new Map<string, number[]>();
const rpmOf = (p: ProviderConfig) => (p.rpm ?? 0) || (p.kind === 'gemini' ? 14 : 0);

/**
 * Wait for a free slot under the provider's per-minute limit. Returns false when the wait would be
 * long (then the next model / provider is tried instead).
 */
async function pace(p: ProviderConfig, signal: AbortSignal, maxWaitMs = 20_000): Promise<boolean> {
  const rpm = rpmOf(p);
  if (!rpm) return true;
  const key = `${p.id}:${p.model}`;
  for (;;) {
    const now = Date.now();
    const times = (recent.get(key) ?? []).filter((t) => now - t < 60_000);
    recent.set(key, times);
    if (times.length < rpm) {
      times.push(now);
      return true;
    }
    const wait = 60_000 - (now - times[0]) + 250;
    if (wait > maxWaitMs) return false;
    log.debug(`${p.label} · ${p.model}: ${rpm}/min reached, waiting ${Math.round(wait / 1000)} s`);
    await sleep(wait, signal);
  }
}

/** A provider, then the same provider with each of its extra models (same key, separate quota). */
function withAltModels(chain: ProviderConfig[]): ProviderConfig[] {
  return chain.flatMap((p) => [
    p,
    ...(p.altModels ?? '')
      .split(/[,\s]+/)
      .map((m) => m.trim())
      .filter((m) => m && m !== p.model)
      .map((m) => ({ ...p, model: m, label: `${p.label} (${m})` })),
  ]);
}

export async function generateWithFallback(s: Settings, req: LLMRequest, only?: string): Promise<ChainResult> {
  const chain = withAltModels(only ? s.providers.filter((p) => p.id === only) : activeProviders(s));
  if (!chain.length) {
    throw new LLMError('no-provider', 'No AI provider is configured.', {
      hint: s.privacy.localOnly
        ? 'Local-only mode is on: enable Chrome AI or Ollama in settings.'
        : 'Open FormPilot settings → Providers and add a free Gemini / OpenRouter / Groq key, or enable Chrome AI or Ollama.',
    });
  }
  const attempts: ChainResult['attempts'] = [];
  let lastErr: unknown;
  let limitErr: LLMError | undefined;
  const tryList = s.generation.fallback || only ? chain : chain.slice(0, 1 + chain.filter((x, i) => i > 0 && x.id === chain[0].id).length);

  for (const p of tryList) {
    const ck = `${p.id}:${p.model}`;
    const until = cooldown.get(ck) ?? cooldown.get(p.id);
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
    // Stay under the per-minute limit; if the wait is long, try the next model / provider now.
    if (tryList.length > 1 && !(await pace(p, req.signal))) {
      log.info(`${p.label} · ${p.model} is at its per-minute limit; trying the next one`);
      continue;
    }
    for (let attempt = 0; attempt <= s.generation.maxRetries; attempt++) {
      const t0 = performance.now();
      try {
        log.info(`→ ${p.label} · ${p.model}${attempt ? ` (retry ${attempt})` : ''}`);
        const r = await adapterFor(p).generate(await resolveProvider(p), req);
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
        // Out of today's quota for this model: skip it until tomorrow-ish; other models may still work.
        if (err.code === 'quota') cooldown.set(`${p.id}:${p.model}`, Date.now() + 3 * 3600_000);
        if (err.code === 'quota' || err.code === 'rate-limit') limitErr ??= err;
        if (['auth', 'cors', 'no-provider'].includes(err.code)) {
          cooldown.set(p.id, Date.now() + 5 * 60_000);
        } else if (err.code === 'unavailable' && p.kind === 'chrome-ai') {
          cooldown.set(p.id, Date.now() + 10 * 60_000);
        }
        if (err.code === 'locked') break; // no point retrying; try the next (maybe local) provider
        if (!err.retryable || attempt >= s.generation.maxRetries) break;
        const wait = err.retryAfterMs ?? 600 * 2 ** attempt + Math.random() * 300;
        if (wait > 8000) {
          if (err.code === 'rate-limit') cooldown.set(`${p.id}:${p.model}`, Date.now() + wait);
          break; // too long: fall through to the next provider
        }
        await sleep(wait, req.signal);
      }
    }
  }
  // A used-up quota or a rate limit says more than the fallback that couldn't be reached after it
  // (the pilots wait for the reset on those, instead of skipping the job).
  if (limitErr && lastErr instanceof LLMError && !['quota', 'rate-limit'].includes(lastErr.code)) throw limitErr;
  if (lastErr instanceof LLMError) throw lastErr;
  throw new LLMError('unknown', (lastErr as Error)?.message ?? 'All providers failed.');
}
