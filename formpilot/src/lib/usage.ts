/**
 * Anonymous usage reporting (Options → Privacy & Data → Share anonymous usage), on by
 * default and silent in Local-only mode. Background only. Sends feature names, daily
 * counts, setup milestones, the provider *type* and error types to
 * POST /v1/app/formpilot with a random install id. Never field contents, page URLs,
 * memory, provider URLs, headers or keys. Turning it off deletes what was sent.
 */
import type { ProviderConfig, Settings } from './settings';

export const USAGE_ENDPOINT = 'https://api.np-dev.duckdns.org/v1/app/formpilot';
const KEY = 'usage';
const MAX_PENDING = 500;
const MAX_CRASHES = 20;

type Props = Record<string, string>;
interface UsageState {
  installId: string;
  pending: { n: string; t: number; p?: Props }[];
  counters: Record<string, number>;
  once: string[];
  crashes: { fp: string; m: string; st?: string; t: number; fatal: boolean }[];
  lastVersion?: string;
  dailyChecked?: string;
  offPending?: boolean;
}

/* ---------- pure helpers (unit-tested) ---------- */

/** Suggestion source → the report's value. */
export function usageSource(s: string | undefined): string {
  if (s === 'fact') return 'memory';
  if (s === 'history' || s === 'ai' || s === 'cache') return s;
  return 'other';
}

/** The provider family from its preset id (built-ins use the preset id; extras are `<preset>-xxxx`). Never the URL. */
export function providerFamily(p: Pick<ProviderConfig, 'id' | 'kind'> | undefined): string {
  if (!p) return 'none';
  const preset = p.id.replace(/-[a-z0-9]{4,}$/i, '');
  if (preset === 'gemini') return 'gemini';
  if (preset === 'chrome-ai') return 'chrome_ai';
  if (preset === 'openrouter') return 'openrouter';
  if (preset === 'groq') return 'groq';
  if (preset === 'ollama' || p.kind === 'ollama') return 'ollama';
  if (p.kind === 'chrome-ai') return 'chrome_ai';
  if (p.kind === 'gemini') return 'gemini';
  return 'openai_compatible';
}

export function counterKey(day: string, name: string, props: Props = {}): string {
  return [day, name, ...Object.keys(props).sort().map((k) => `${k}=${props[k]}`)].join('|');
}

export function parseCounterKey(key: string): { day: string; name: string; props: Props } | null {
  const [day, name, ...rest] = key.split('|');
  if (!day || !name) return null;
  const props: Props = {};
  for (const r of rest) {
    const i = r.indexOf('=');
    if (i > 0) props[r.slice(0, i)] = r.slice(i + 1);
  }
  return { day, name, props };
}

export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Noon on that local day, so a counter lands on its day in any report. */
export const noonOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12).getTime();
};

/** A short stable hash for grouping errors (name + top frames, never the message). */
export function errorFingerprint(name: string, stack = ''): string {
  const frames = stack.split('\n').slice(1, 4).map((l) => l.trim().replace(/:\d+:\d+\)?$/, '')).join(';');
  let h = 0;
  for (const c of `${name}|${frames}`) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/* ---------- reporter ---------- */

export class UsageReporter {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private settings: () => Settings,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** Sharing on, and not in Local-only mode (which promises nothing leaves the computer). */
  get enabled() {
    const p = this.settings().privacy;
    return p.shareUsage && !p.localOnly;
  }

  /** Serialise read-modify-write of the stored state. */
  private update<T>(fn: (s: UsageState) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const s = await this.load();
      const out = fn(s);
      await chrome.storage.local.set({ [KEY]: s });
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<UsageState> {
    const got = (await chrome.storage.local.get(KEY))[KEY] as UsageState | undefined;
    return got?.installId ? got : { installId: crypto.randomUUID(), pending: [], counters: {}, once: [], crashes: [] };
  }

  event(name: string, props?: Props) {
    if (!this.enabled) return Promise.resolve();
    return this.update((s) => {
      if (s.pending.length < MAX_PENDING) s.pending.push({ n: name, t: Date.now(), ...(props ? { p: props } : {}) });
    });
  }

  count(name: string, props: Props = {}, n = 1) {
    if (!this.enabled || n <= 0) return Promise.resolve();
    return this.update((s) => {
      const k = counterKey(localDay(), name, props);
      s.counters[k] = (s.counters[k] ?? 0) + n;
    });
  }

  /** A milestone sent once per install. */
  once(name: string) {
    if (!this.enabled) return Promise.resolve();
    return this.update((s) => {
      if (s.once.includes(name)) return;
      s.once.push(name);
      s.pending.push({ n: name, t: Date.now() });
    });
  }

  error(e: unknown, fatal = false) {
    if (!this.enabled) return Promise.resolve();
    const err = e instanceof Error ? e : new Error('non-error');
    return this.update((s) => {
      if (s.crashes.length >= MAX_CRASHES) return;
      s.crashes.push({
        fp: errorFingerprint(err.name, err.stack),
        m: err.name.slice(0, 200), // the message can contain page text: not sent
        st: (err.stack ?? '').split('\n').slice(1, 20).join('\n').slice(0, 4000),
        t: Date.now(),
        fatal,
      });
    });
  }

  /** Version changes since the last run (install / update events). */
  checkVersion(version: string) {
    if (!this.enabled) return Promise.resolve();
    return this.update((s) => {
      if (!s.lastVersion) s.pending.push({ n: 'app_installed', t: Date.now() });
      else if (s.lastVersion !== version) s.pending.push({ n: 'app_update', t: Date.now(), p: { from: s.lastVersion.slice(0, 16), to: version } });
      s.lastVersion = version;
    });
  }

  turnedOff() {
    return this.update((s) => {
      s.pending = [];
      s.counters = {};
      s.crashes = [];
      s.offPending = true;
    }).then(() => this.flush());
  }

  turnedOn() {
    return this.update((s) => {
      s.offPending = false;
    });
  }

  /** Send queued events, finished days' counters and errors; drop them once accepted. */
  async flush(daily?: () => { facts: Record<string, Props>; setup: string[] }) {
    const state = await this.update((s) => s);
    if (state.offPending) {
      if (await this.post({ ...this.base(state.installId), off: true })) await this.update((s) => void (s.offPending = false));
      return;
    }
    if (!this.enabled) return;
    if (daily && state.dailyChecked !== localDay()) {
      const d = daily();
      await this.update((s) => void (s.dailyChecked = localDay()));
      for (const [name, props] of Object.entries(d.facts)) await this.event(name, props);
      for (const step of d.setup) await this.once(step);
    }
    const snap = await this.update((s) => ({
      pending: [...s.pending],
      crashes: [...s.crashes],
      counters: Object.entries(s.counters).filter(([k]) => parseCounterKey(k)?.day !== localDay()),
    }));
    const events = [
      ...snap.pending,
      ...snap.counters.flatMap(([k, c]) => {
        const p = parseCounterKey(k);
        return p ? [{ n: p.name, t: noonOf(p.day), c, ...(Object.keys(p.props).length ? { p: p.props } : {}) }] : [];
      }),
    ];
    if (!events.length && !snap.crashes.length) return;
    if (!(await this.post({ ...this.base(state.installId), e: events, cr: snap.crashes }))) return;
    await this.update((s) => {
      s.pending = s.pending.slice(snap.pending.length);
      s.crashes = s.crashes.slice(snap.crashes.length);
      for (const [k] of snap.counters) delete s.counters[k];
    });
  }

  private base(installId: string) {
    const nav = globalThis.navigator as Navigator & { userAgentData?: { platform?: string } };
    const brave = (nav as Navigator & { brave?: unknown }).brave !== undefined;
    return {
      i: installId,
      v: chrome.runtime.getManifest().version,
      pf: brave ? 'brave' : 'chrome',
      os: (nav.userAgentData?.platform ?? 'unknown').slice(0, 32),
      dc: 'browser',
      loc: (nav.language ?? '').slice(0, 16),
    };
  }

  private async post(body: unknown): Promise<boolean> {
    try {
      const r = await this.fetchImpl(USAGE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }
}
