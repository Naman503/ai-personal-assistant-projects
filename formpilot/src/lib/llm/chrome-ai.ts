/**
 * Chrome built-in AI (Gemini Nano via the Prompt API, `LanguageModel` global).
 *
 * The Prompt API is only exposed to Window contexts, not to the service worker,
 * so generation is proxied to an offscreen document (entrypoints/offscreen).
 * Brave and other Chromium forks don't ship it, and we report that clearly.
 */

import { LLMError, type ProviderAdapter } from './types';
import { uid } from '../util';
import { createLogger } from '../logger';

const log = createLogger('bg:chrome-ai');
const NAME = 'Chrome AI';
const OFFSCREEN_URL = 'offscreen.html';

let creating: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<void> {
  if (!chrome.offscreen) throw new LLMError('unavailable', 'Offscreen documents are not supported in this browser.', { provider: NAME });
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Run the on-device Gemini Nano model (Prompt API), which is only available in window contexts.',
      })
      .catch((e: Error) => {
        // Another caller won the race.
        if (!/single offscreen|already/i.test(e.message)) throw e;
      })
      .finally(() => (creating = null));
  }
  await creating;
}

type NanoResponse = { ok: true; text: string } | { ok: false; error: string; code?: string };

const chunkListeners = new Map<string, (text: string) => void>();

/** Install once in the background: routes streamed chunks from the offscreen doc. */
export function installChromeAiRelay() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === 'background' && msg.type === 'nano:chunk') chunkListeners.get(msg.reqId)?.(msg.text);
    return false;
  });
}

let cached: { status: string; at: number } | null = null;
const CACHE_MS = 10 * 60_000;

/**
 * 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'no-api'.
 * Cached for 10 minutes, so an unsupported browser (e.g. Brave) costs one check, not one per request.
 */
export async function chromeAiAvailability(fresh = false): Promise<string> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  let status = 'unavailable';
  try {
    await ensureOffscreen();
    const r = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'nano:availability' })) as { status: string } | undefined;
    status = r?.status ?? 'unavailable';
  } catch (e) {
    log.debug('availability check failed', e);
  }
  if (cached?.status !== status) log.info(`Chrome built-in AI status: ${status}${status === 'available' ? '' : ' (it will be skipped)'}`);
  cached = { status, at: Date.now() };
  return status;
}

export const chromeAi: ProviderAdapter = {
  async generate(_cfg, req) {
    await ensureOffscreen();
    const reqId = uid('nano');
    if (req.onText) chunkListeners.set(reqId, req.onText);
    const onAbort = () => void chrome.runtime.sendMessage({ target: 'offscreen', type: 'nano:abort', reqId }).catch(() => {});
    req.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = (await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'nano:generate',
        reqId,
        system: req.system,
        prompt: req.prompt,
        schema: req.schema,
        temperature: req.temperature,
        stream: req.stream,
      })) as NanoResponse | undefined;
      if (req.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!res) throw new LLMError('unavailable', 'Chrome AI did not respond.', { provider: NAME });
      if (!res.ok) {
        const code = res.code === 'unavailable' || res.code === 'downloadable' ? 'unavailable' : 'bad-response';
        throw new LLMError(code, res.error, {
          provider: NAME,
          hint:
            res.code === 'downloadable' || res.code === 'downloading'
              ? 'Open FormPilot settings → Providers → Chrome AI and click "Download model".'
              : res.code === 'unavailable'
                ? 'Chrome built-in AI needs Chrome 138+ on desktop with enough disk/RAM. It is not available in Brave.'
                : undefined,
        });
      }
      return { text: res.text, model: 'gemini-nano' };
    } finally {
      chunkListeners.delete(reqId);
      req.signal.removeEventListener('abort', onAbort);
    }
  },
  async listModels() {
    return [{ id: 'gemini-nano', name: 'Gemini Nano', description: 'On-device model built into Chrome. Runs offline.', free: true, installed: true, owner: 'Google' }];
  },
};
