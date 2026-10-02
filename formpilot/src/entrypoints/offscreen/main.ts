/**
 * Offscreen document: hosts Chrome's on-device model (the Prompt API is window-only).
 * The background talks to it with runtime messages tagged `target: 'offscreen'`.
 */
import { nanoAvailability, nanoGenerate } from '@/lib/llm/nano';
import { configureLogger, createLogger } from '@/lib/logger';

configureLogger({ context: 'offscreen' });
const log = createLogger('offscreen');
const controllers = new Map<string, AbortController>();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  if (msg.type === 'nano:availability') {
    nanoAvailability().then((status) => sendResponse({ status }));
    return true;
  }

  if (msg.type === 'nano:abort') {
    controllers.get(msg.reqId)?.abort();
    return false;
  }

  if (msg.type === 'nano:generate') {
    const ctl = new AbortController();
    controllers.set(msg.reqId, ctl);
    let lastSent = 0;
    const t0 = performance.now();
    nanoGenerate(msg, ctl.signal, (text) => {
      const now = performance.now();
      if (now - lastSent < 60) return;
      lastSent = now;
      chrome.runtime.sendMessage({ target: 'background', type: 'nano:chunk', reqId: msg.reqId, text }).catch(() => {});
    })
      .then((text) => {
        log.debug(`nano answered in ${Math.round(performance.now() - t0)}ms`);
        sendResponse({ ok: true, text });
      })
      .catch((e: Error & { code?: string }) => {
        if (['unavailable', 'no-api', 'downloadable', 'downloading'].includes(e.code ?? '')) log.debug(`nano not usable: ${e.message}`);
        else log.warn(`nano failed: ${e.message}`);
        sendResponse({ ok: false, error: e.message, code: e.code });
      })
      .finally(() => controllers.delete(msg.reqId));
    return true;
  }
  return false;
});

log.info('offscreen ready');
