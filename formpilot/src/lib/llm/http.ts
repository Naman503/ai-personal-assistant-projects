/** HTTP helpers shared by providers: error mapping, SSE and NDJSON stream readers. */

import { LLMError } from './types';
import { isAbort } from '../util';

export function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  if (!isNaN(n)) return n * 1000;
  const d = Date.parse(h);
  return isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

function extractMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = j.error ?? j;
    if (typeof e === 'string') return e;
    return e.message ?? e.error ?? body;
  } catch {
    return body.slice(0, 300);
  }
}

/** Map a non-2xx response to a typed, user-actionable error. */
export async function httpError(res: Response, provider: string): Promise<LLMError> {
  const body = await res.text().catch(() => '');
  const msg = extractMessage(body) || res.statusText || `HTTP ${res.status}`;
  const s = res.status;
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  if (s === 401 || (s === 400 && /api[_ ]?key|API_KEY_INVALID/i.test(msg)) || (s === 403 && /key|permission|denied/i.test(msg) && provider !== 'Ollama')) {
    return new LLMError('auth', msg, { status: s, provider, hint: 'Check the API key in FormPilot settings → Providers.' });
  }
  if (s === 403 && provider === 'Ollama') {
    return new LLMError('cors', 'Ollama rejected the request origin (403).', {
      status: s,
      provider,
      hint: 'Reload the extension so its Origin-fix rule is applied, or start Ollama with OLLAMA_ORIGINS="chrome-extension://*".',
    });
  }
  if (s === 404) {
    return new LLMError('bad-response', `Model or endpoint not found: ${msg}`, {
      status: s,
      provider,
      hint: 'Pick a model from the list in settings (use "Fetch models").',
    });
  }
  if (s === 429) {
    return new LLMError('rate-limit', `Rate limited: ${msg}`, {
      status: s,
      provider,
      retryable: true,
      retryAfterMs,
      hint: 'Free tiers have per-minute limits. FormPilot falls back to the next provider automatically.',
    });
  }
  if (s >= 500) return new LLMError('unavailable', `${provider} is unavailable (${s}): ${msg}`, { status: s, provider, retryable: true, retryAfterMs });
  return new LLMError('bad-response', msg, { status: s, provider });
}

/** Wrap fetch so network failures become typed errors. */
export async function safeFetch(url: string, init: RequestInit, provider: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    if ((e as Error)?.name === 'TimeoutError') throw new LLMError('timeout', `${provider} timed out.`, { provider, retryable: true });
    const local = /localhost|127\.0\.0\.1/.test(url);
    throw new LLMError('network', `Could not reach ${provider} (${(e as Error)?.message ?? 'network error'}).`, {
      provider,
      retryable: !local,
      hint: local ? `Is ${provider} running? Check the base URL in settings.` : 'Check your internet connection.',
    });
  }
}

/** Read a Server-Sent Events stream, calling onData for each `data:` payload. */
export async function readSSE(res: Response, onData: (data: string) => void, signal?: AbortSignal): Promise<void> {
  if (!res.body) throw new LLMError('bad-response', 'Empty response body');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      // Events are separated by a blank line; tolerate \r\n.
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) onData(data);
      }
    }
    const tail = buf.trim();
    if (tail.startsWith('data:')) onData(tail.slice(5).trim());
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** Read a newline-delimited JSON stream (Ollama). */
export async function readNDJSON(res: Response, onObj: (o: Record<string, unknown>) => void, signal?: AbortSignal): Promise<void> {
  if (!res.body) throw new LLMError('bad-response', 'Empty response body');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onObj(JSON.parse(line));
      }
    }
    if (buf.trim()) onObj(JSON.parse(buf.trim()));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
