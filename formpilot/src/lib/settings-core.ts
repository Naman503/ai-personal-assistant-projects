/**
 * Zod-free settings helpers, safe to import from the content script (which runs on
 * every page, so it must stay small). The zod schema in settings.ts is the
 * validator. DEFAULTS here must match `parseSettings({})`, and a unit test enforces that.
 */
import type { ProviderConfig, ProviderKind, Settings } from './settings';

export interface ProviderPreset {
  presetId: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  keyUrl?: string;
  free: 'free' | 'free-tier' | 'local';
  blurb: string;
  models: string[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    presetId: 'gemini',
    kind: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.5-flash-lite',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    free: 'free-tier',
    blurb: 'Fast and high quality. The free API key from AI Studio is enough for personal use.',
    models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
  },
  {
    presetId: 'chrome-ai',
    kind: 'chrome-ai',
    label: 'Chrome built-in AI (Gemini Nano)',
    baseUrl: '',
    model: 'gemini-nano',
    needsKey: false,
    free: 'local',
    blurb: 'Runs on-device inside Chrome: free, private, works offline. Chrome only, not available in Brave.',
    models: ['gemini-nano'],
  },
  {
    presetId: 'openrouter',
    kind: 'openai',
    label: 'OpenRouter (free models)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    free: 'free',
    blurb: 'Free models (":free" suffix, ~50 req/day). "openrouter/free" auto-picks one. Needs a free key.',
    // The free line-up changes weekly: "Fetch models" in settings loads the live list.
    models: ['openrouter/free', 'qwen/qwen3.8-27b:free', 'nvidia/nemotron-3-super-120b-a12b:free'],
  },
  {
    presetId: 'groq',
    kind: 'openai',
    label: 'Groq (free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.1-8b-instant',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    free: 'free-tier',
    blurb: 'Extremely fast inference. Generous free tier with a free key.',
    models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
  },
  {
    presetId: 'ollama',
    kind: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
    needsKey: false,
    keyUrl: 'https://ollama.com/download',
    free: 'local',
    blurb: 'Run open models on your own machine. 100% private and free.',
    models: ['llama3.2', 'qwen2.5:7b', 'gemma3:4b', 'mistral'],
  },
  {
    presetId: 'lmstudio',
    kind: 'openai',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    model: '',
    needsKey: false,
    keyUrl: 'https://lmstudio.ai',
    free: 'local',
    blurb: 'Local OpenAI-compatible server from LM Studio.',
    models: [],
  },
  {
    presetId: 'custom',
    kind: 'openai',
    label: 'Custom OpenAI-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    free: 'free-tier',
    blurb: 'Any /chat/completions endpoint: OpenAI, Mistral, Together, DeepSeek, Cerebras…',
    models: [],
  },
];

export function providerFromPreset(presetId: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const p = PROVIDER_PRESETS.find((x) => x.presetId === presetId) ?? PROVIDER_PRESETS[0];
  return {
    id: overrides.id ?? p.presetId,
    kind: p.kind,
    label: p.label,
    enabled: true,
    apiKey: '',
    hasKey: false,
    baseUrl: p.baseUrl,
    model: p.model,
    jsonMode: true,
    headers: p.presetId === 'openrouter' ? { 'X-Title': 'FormPilot' } : {},
    ...overrides,
  };
}


export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  providerFromPreset('gemini'),
  providerFromPreset('chrome-ai'),
  providerFromPreset('openrouter'),
  providerFromPreset('groq'),
  providerFromPreset('ollama', { enabled: false }),
];

export const DEFAULTS: Settings = {
  version: 1,
  onboarded: false,
  providers: DEFAULT_PROVIDERS,
  generation: {
    numSuggestions: 3,
    temperature: 0.7,
    thinking: 'off',
    maxOutputTokens: 1024,
    length: 'auto',
    tone: 'auto',
    language: 'auto',
    grounding: 'balanced',
    customInstructions: '',
    persona: '',
    includePageContext: true,
    pageContextChars: 3000,
    includeOtherFields: true,
    streaming: true,
    timeoutMs: 45000,
    maxRetries: 2,
    fallback: true,
  },
  memory: {
    enabled: true,
    topK: 6,
    chunkSize: 900,
    chunkOverlap: 150,
    contextBudgetChars: 8000,
    useEmbeddings: false,
    embeddingModel: 'gemini-embedding-2',
    autoExtractFacts: true,
  },
  behavior: {
    enabled: true,
    trigger: 'focus',
    autoGenerate: true,
    generateDelayMs: 250,
    showFieldIcon: true,
    fieldTypes: { input: true, textarea: true, contenteditable: true, select: true },
    autoOpenOnContentEditable: false,
    chatSites: ['naukri.com'],
    insertMode: 'replace',
    skipSearchFields: true,
    minFieldWidth: 80,
    siteMode: 'all',
    blockedSites: [],
    allowedSites: [],
    highlightOnFill: true,
    closeOnInsert: true,
  },
  cache: { instantFacts: true, history: true, historyThreshold: 0.55, responseCache: true, responseCacheTtlHours: 72, learn: 'ask', learnSaveAs: 'smart' },
  privacy: { redactSecrets: true, localOnly: false, sendPageUrl: true, shareUsage: true },
  appearance: { theme: 'system', accent: 'violet', density: 'comfortable', dropdownMaxWidth: 440, reduceMotion: false },
  panel: {
    placement: 'auto',
    draggable: true,
    rememberPosition: 'per-site',
    dragAnchor: 'screen',
    pinnedByDefault: false,
    closeOnBlur: true,
    reopenOnClick: true,
    hideWhileTyping: true,
    maxHeight: 520,
    opacity: 100,
    showHeader: true,
    showActions: true,
    showFooter: true,
    showBadges: true,
    showGroupLabels: true,
    numberShortcuts: true,
    tabAccepts: false,
  },
  debug: { logLevel: 'info', console: true },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge stored settings over defaults, keeping only keys whose type matches. */
export function mergeSettings(raw: unknown): Settings {
  const merge = (def: unknown, val: unknown): unknown => {
    if (val === undefined || val === null) return structuredClone(def);
    if (Array.isArray(def)) return Array.isArray(val) ? val : structuredClone(def);
    if (isObj(def)) {
      if (!isObj(val)) return structuredClone(def);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(def)) out[k] = merge(def[k], val[k]);
      return out;
    }
    return typeof val === typeof def ? val : def;
  };
  return merge(DEFAULTS, raw) as Settings;
}

const KEY = 'settings';

/** Lightweight load for the content script (no zod). */
export async function loadSettingsLite(): Promise<Settings> {
  const res = await chrome.storage.local.get(KEY);
  return mergeSettings(res[KEY]);
}

export function watchSettingsLite(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) cb(mergeSettings(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Is a provider usable without a network round-trip (has key when needed)? */
export function providerConfigured(p: ProviderConfig): boolean {
  if (!p.enabled) return false;
  const hasKey = !!p.apiKey.trim() || !!p.hasKey;
  if (p.kind === 'gemini') return hasKey;
  if (p.kind === 'openai') {
    const preset = PROVIDER_PRESETS.find((x) => x.baseUrl && p.baseUrl.startsWith(x.baseUrl));
    if (preset?.needsKey && !hasKey) return false;
    return !!p.baseUrl && !!p.model;
  }
  if (p.kind === 'ollama') return !!p.baseUrl && !!p.model;
  return true;
}

export function isLocalProvider(p: ProviderConfig): boolean {
  if (p.kind === 'chrome-ai') return true;
  try {
    const h = new URL(p.baseUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local');
  } catch {
    return false;
  }
}
