/**
 * Anonymous usage reporting (Options → Privacy & Data → Share anonymous usage), on by
 * default and silent in Local-only mode. Only the background sends: the content script,
 * toolbar popup and options page ask it to record allowlisted events (CLIENT_EVENTS).
 * Sends feature names, daily counts, setup milestones, outcomes, error categories,
 * latency and size buckets, the provider *type* and a daily settings snapshot (enums,
 * booleans, buckets) to POST /v1/app/formpilot with a random install id. Never field
 * contents, page URLs or sites, memory, file names, models, provider URLs, headers or
 * keys. Turning it off deletes what was sent.
 */
import type { ProviderConfig, Settings } from './settings';

export const USAGE_ENDPOINT = 'https://api.np-dev.duckdns.org/v1/app/formpilot';
const KEY = 'usage';
const MAX_PENDING = 500;
const MAX_CRASHES = 20;

export type PropValue = string | number | boolean;
export type Props = Record<string, PropValue>;
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

export function parseCounterKey(key: string): { day: string; name: string; props: Record<string, string> } | null {
  const [day, name, ...rest] = key.split('|');
  if (!day || !name) return null;
  const props: Record<string, string> = {};
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

/** A latency as a coarse bucket (never the exact time). */
export function msBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 500) return '<0.5s';
  if (ms < 1000) return '0.5-1s';
  if (ms < 2000) return '1-2s';
  if (ms < 5000) return '2-5s';
  if (ms < 10_000) return '5-10s';
  if (ms < 30_000) return '10-30s';
  return '30s+';
}

/** A count as a coarse bucket. */
export function countBucket(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 5) return '2-5';
  if (n <= 20) return '6-20';
  if (n <= 100) return '21-100';
  if (n <= 500) return '101-500';
  return '500+';
}

/** Characters of memory as a coarse size bucket. */
export function charsBucket(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 10_000) return '<10k';
  if (n < 50_000) return '10-50k';
  if (n < 200_000) return '50-200k';
  if (n < 1_000_000) return '200k-1M';
  return '1M+';
}

/** An AI error code (ErrorInfo['code']) → the report's category. */
export function errorCategory(code: string | undefined): string {
  switch (code) {
    case 'rate-limit':
      return 'rate_limit';
    case 'auth':
      return 'auth';
    case 'timeout':
      return 'timeout';
    case 'network':
    case 'cors':
      return 'network';
    case 'no-provider':
      return 'no_provider';
    case 'locked':
      return 'locked';
    case 'unavailable':
      return 'unavailable';
    case 'bad-response':
      return 'bad_response';
    case 'blocked':
      return 'blocked';
    default:
      return 'other';
  }
}

const DOC_KINDS = ['pdf', 'docx', 'txt', 'md', 'csv', 'json', 'html', 'note'];
/** A document type (or file extension) → a fixed enum. Never the file name. */
export function docKind(kind: string | undefined): string {
  const k = (kind ?? '').toLowerCase().replace(/^.*\./, '');
  if (k === 'markdown') return 'md';
  if (k === 'htm') return 'html';
  if (k === 'text') return 'txt';
  return DOC_KINDS.includes(k) ? k : 'other';
}

/**
 * Events the content script, toolbar popup and options page may ask the background to record.
 * Each lists its props and their allowed values (`number` = a finite number, `bool` = a boolean).
 * Anything else is dropped, so a page can never smuggle text into a report.
 */
type Allowed = readonly string[] | 'number' | 'bool';
const OPEN_TRIGGERS = ['auto', 'icon', 'shortcut', 'context_menu', 'alt_down', 'click_reopen', 'chat_question'] as const;
const SOURCES = ['memory', 'history', 'ai', 'cache', 'other'] as const;
export const OPTIONS_SECTIONS = ['overview', 'providers', 'local', 'memory', 'generation', 'behavior', 'popup', 'cache', 'privacy', 'appearance', 'logs', 'about'] as const;
export const CLIENT_EVENTS: Record<string, { counter: boolean; props?: Record<string, Allowed> }> = {
  field_focused: { counter: true, props: { mode: ['auto_open', 'icon', 'shortcut'], chat: 'bool' } },
  suggestions_shown: { counter: true, props: { first: ['instant', 'ai', 'cache'], trigger: OPEN_TRIGGERS } },
  popup_action: {
    counter: true,
    props: {
      action: ['regenerate', 'shorter', 'longer', 'refine_open', 'refine', 'generate', 'pin', 'unpin', 'move', 'reset_position', 'remember', 'pause_site', 'settings', 'fill_form', 'close', 'escape'],
    },
  },
  popup_key: { counter: true, props: { key: ['arrows', 'enter', 'tab', 'escape', 'alt_number', 'alt_down'] } },
  insert_failed: { counter: true, props: { source: SOURCES } },
  undo_used: { counter: true, props: { what: ['insert', 'form'] } },
  learn_prompt: { counter: true, props: { action: ['shown', 'accepted', 'dismissed'] } },
  chat_question: { counter: true, props: { found: 'bool' } },
  form_fill_applied: { counter: false, props: { fields: 'number', filled: 'number', trigger: ['shortcut', 'context_menu', 'popup_menu', 'toolbar'] } },
  toolbar_popup_opened: { counter: true, props: { site_active: 'bool', provider_ready: 'bool', locked: 'bool' } },
  toolbar_action: { counter: true, props: { action: ['fill_form', 'providers', 'memory', 'settings', 'logs', 'about', 'email', 'toggle_extension', 'toggle_site'] } },
  options_opened: { counter: true },
  options_section_viewed: { counter: true, props: { section: OPTIONS_SECTIONS } },
  options_action: {
    counter: true,
    props: {
      action: [
        'doc_uploaded', 'doc_failed', 'note_added', 'note_edited', 'doc_deleted', 'doc_toggled', 'fact_added', 'fact_edited', 'fact_deleted',
        'facts_reextract', 'rechunk', 'memory_search', 'backup_exported', 'backup_imported', 'backup_import_failed', 'wipe_all',
        'vault_created', 'vault_unlocked', 'vault_mode_changed', 'password_changed', 'provider_added', 'provider_removed',
        'provider_reordered', 'local_model_installed', 'local_model_removed', 'logs_cleared', 'logs_exported',
      ],
      provider: ['gemini', 'chrome_ai', 'openrouter', 'groq', 'ollama', 'lmstudio', 'custom'],
    },
  },
};

/** Keep only allowlisted names, keys and values (≤ 8 props, strings ≤ 64). */
export function sanitizeClientEvent(name: unknown, props: unknown): { name: string; counter: boolean; props: Props } | null {
  if (typeof name !== 'string' || !Object.hasOwn(CLIENT_EVENTS, name)) return null;
  const spec = CLIENT_EVENTS[name]!;
  const out: Props = {};
  const given = props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
  for (const [k, allowed] of Object.entries(spec.props ?? {})) {
    const v = given[k];
    if (v === undefined) continue;
    if (allowed === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v);
    } else if (allowed === 'bool') {
      if (typeof v === 'boolean') out[k] = v;
    } else if (typeof v === 'string' && allowed.includes(v)) out[k] = v;
  }
  return { name, counter: spec.counter, props: out };
}

/** A section id from the options URL hash → an allowed section (or 'other'). */
export function optionsSection(raw: string | undefined): string {
  const id = (raw ?? '').replace(/^#/, '').split('?')[0] || 'overview';
  return (OPTIONS_SECTIONS as readonly string[]).includes(id) ? id : 'other';
}

/** Daily snapshot of settings: fixed enums, booleans and buckets only (never sites, prompts, URLs or models). */
export function settingsSnapshot(s: Settings): Record<string, Props> {
  const g = s.generation;
  const b = s.behavior;
  const p = s.panel;
  const c = s.cache;
  const m = s.memory;
  return {
    settings_generation: {
      suggestions: g.numSuggestions,
      thinking: g.thinking,
      length: g.length,
      tone: g.tone,
      grounding: g.grounding,
      streaming: g.streaming,
      fallback: g.fallback,
      page_context: g.includePageContext,
    },
    settings_generation_more: {
      language_auto: g.language === 'auto',
      custom_instructions: !!g.customInstructions.trim(),
      persona: !!g.persona.trim(),
      other_fields: g.includeOtherFields,
      timeout: msBucket(g.timeoutMs),
      retries: g.maxRetries,
      temperature: Math.round(g.temperature * 10) / 10,
    },
    settings_behavior: {
      enabled: b.enabled,
      trigger: b.trigger,
      auto_generate: b.autoGenerate,
      field_icon: b.showFieldIcon,
      insert_mode: b.insertMode,
      site_mode: b.siteMode,
      blocked_sites: countBucket(b.blockedSites.length),
      chat_sites: countBucket(b.chatSites.length),
    },
    settings_panel: {
      placement: p.placement,
      remember_position: p.rememberPosition,
      pinned_default: p.pinnedByDefault,
      close_on_blur: p.closeOnBlur,
      hide_while_typing: p.hideWhileTyping,
      number_shortcuts: p.numberShortcuts,
      tab_accepts: p.tabAccepts,
      draggable: p.draggable,
    },
    settings_memory: {
      enabled: m.enabled,
      embeddings: m.useEmbeddings,
      auto_facts: m.autoExtractFacts,
      instant_facts: c.instantFacts,
      history: c.history,
      response_cache: c.responseCache,
      learn: c.learn,
      learn_save_as: c.learnSaveAs,
    },
    settings_privacy_look: {
      redact_secrets: s.privacy.redactSecrets,
      send_url: s.privacy.sendPageUrl,
      theme: s.appearance.theme,
      accent: s.appearance.accent,
      density: s.appearance.density,
      reduce_motion: s.appearance.reduceMotion,
      log_level: s.debug.logLevel,
      onboarded: s.onboarded,
    },
  };
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
    const err = e instanceof Error ? e : new Error('non-error');
    return this.crash(err.name, err.stack, fatal);
  }

  /**
   * Record an error by its class and stack only: the message can contain page text, so it is never sent.
   * `where` tags errors forwarded from other contexts (content script, options page, popup).
   */
  crash(name: string, stack: string | undefined, fatal = false, where?: string) {
    if (!this.enabled) return Promise.resolve();
    const cls = (name || 'Error').replace(/[^A-Za-z0-9_$.]/g, '').slice(0, 60) || 'Error';
    // Forwarded stacks keep only our own frames (a page's script URLs never leave the browser).
    // Only "at …" frame lines: a multi-line message can never slip in.
    const lines = (stack ?? '').split('\n').filter((l) => /^\s+at\s/.test(l));
    const frames = (where ? lines.filter((l) => l.includes('-extension://')) : lines).slice(0, 19).join('\n').slice(0, 4000);
    return this.update((s) => {
      if (s.crashes.length >= MAX_CRASHES) return;
      s.crashes.push({
        fp: errorFingerprint(`${where ?? ''}${cls}`, `${cls}\n${frames}`),
        m: (where ? `${where}: ${cls}` : cls).slice(0, 200),
        st: frames,
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
  async flush(daily?: () => Promise<{ facts: Record<string, Props>; setup: string[] }>) {
    const state = await this.update((s) => s);
    if (state.offPending) {
      if (await this.post({ ...this.base(state.installId), off: true })) await this.update((s) => void (s.offPending = false));
      return;
    }
    if (!this.enabled) return;
    if (daily && state.dailyChecked !== localDay()) {
      const d = await daily().catch(() => ({ facts: {}, setup: [] as string[] }));
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
