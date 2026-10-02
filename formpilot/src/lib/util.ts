/** Small, dependency-free helpers shared by every context. */

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });

export function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

export const isAbort = (e: unknown) =>
  e instanceof DOMException ? e.name === 'AbortError' : (e as { name?: string })?.name === 'AbortError';

/** Combine abort signals and an optional timeout into one signal. */
export function linkSignals(signals: (AbortSignal | undefined)[], timeoutMs?: number): AbortSignal {
  const list = signals.filter(Boolean) as AbortSignal[];
  if (timeoutMs) list.push(AbortSignal.timeout(timeoutMs));
  return AbortSignal.any(list);
}

/** FNV-1a 32-bit — fast, stable, good enough for cache keys. */
export function hash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Lowercase, strip punctuation/required markers, collapse whitespace. */
export function normalizeText(s: string | undefined | null): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[*:?()[\]{}"'`’“”.,;!|\\/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function collapseWs(s: string | undefined | null): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** Cut text to a max length on a word/sentence boundary, without an ellipsis (for maxlength fields). */
export function clampToLength(s: string, max: number | undefined): string {
  if (!max || max <= 0 || s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = cut.lastIndexOf('. ');
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.6) return cut.slice(0, space).replace(/[,;:\s]+$/, '');
  return cut;
}

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!p) return false;
  const h = host.toLowerCase();
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p || h.endsWith('.' + p);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
