import { z } from 'zod';
import { DEFAULT_PROVIDERS } from './settings-core';

export * from './settings-core';

/**
 * Single source of truth for user settings.
 *
 * Every field has a `.catch()` default, so a corrupt or outdated stored value
 * can never crash the extension. Missing keys are filled in and unknown
 * keys are dropped. That makes schema migrations automatic.
 */

/** `.prefault(EMPTY)` runs `{}` through the schema so every `.catch()` default applies. */
const EMPTY = {} as never;

export const PROVIDER_KINDS = ['gemini', 'openai', 'ollama', 'chrome-ai'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

const ProviderSchema = z.object({
  id: z.string(),
  kind: z.enum(PROVIDER_KINDS),
  label: z.string().catch('Provider'),
  enabled: z.boolean().catch(true),
  /** Legacy plaintext key. New keys live encrypted in the vault (src/lib/vault.ts); this stays ''. */
  apiKey: z.string().catch(''),
  /** A key for this provider is stored in the encrypted vault. */
  hasKey: z.boolean().catch(false),
  baseUrl: z.string().catch(''),
  model: z.string().catch(''),
  /** OpenAI-compatible only: send `response_format: json_object` (some free models reject it). */
  jsonMode: z.boolean().catch(true),
  /** Optional per-provider extra headers, e.g. OpenRouter attribution. */
  headers: z.record(z.string(), z.string()).catch({}),
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;

const GenerationSchema = z.object({
  numSuggestions: z.number().int().min(1).max(5).catch(3),
  temperature: z.number().min(0).max(2).catch(0.7),
  /** Gemini 3.x thinking level; "minimal" keeps latency lowest. */
  thinking: z.enum(['off', 'low', 'medium', 'high']).catch('off'),
  maxOutputTokens: z.number().int().min(64).max(8192).catch(1024),
  length: z.enum(['auto', 'short', 'medium', 'long']).catch('auto'),
  tone: z.enum(['auto', 'professional', 'friendly', 'formal', 'casual', 'confident', 'concise']).catch('auto'),
  language: z.string().catch('auto'),
  grounding: z.enum(['strict', 'balanced', 'creative']).catch('balanced'),
  customInstructions: z.string().max(4000).catch(''),
  persona: z.string().max(2000).catch(''),
  includePageContext: z.boolean().catch(true),
  pageContextChars: z.number().int().min(0).max(20000).catch(3000),
  includeOtherFields: z.boolean().catch(true),
  streaming: z.boolean().catch(true),
  timeoutMs: z.number().int().min(3000).max(180000).catch(45000),
  maxRetries: z.number().int().min(0).max(5).catch(2),
  fallback: z.boolean().catch(true),
});

const MemorySchema = z.object({
  enabled: z.boolean().catch(true),
  topK: z.number().int().min(1).max(20).catch(6),
  chunkSize: z.number().int().min(200).max(4000).catch(900),
  chunkOverlap: z.number().int().min(0).max(1000).catch(150),
  contextBudgetChars: z.number().int().min(500).max(60000).catch(8000),
  useEmbeddings: z.boolean().catch(false),
  embeddingModel: z.string().catch('gemini-embedding-2'),
  autoExtractFacts: z.boolean().catch(true),
});

const BehaviorSchema = z.object({
  enabled: z.boolean().catch(true),
  trigger: z.enum(['focus', 'icon', 'shortcut']).catch('focus'),
  autoGenerate: z.boolean().catch(true),
  generateDelayMs: z.number().int().min(0).max(3000).catch(250),
  showFieldIcon: z.boolean().catch(true),
  fieldTypes: z
    .object({
      input: z.boolean().catch(true),
      textarea: z.boolean().catch(true),
      contenteditable: z.boolean().catch(true),
      select: z.boolean().catch(true),
    })
    .prefault(EMPTY),
  autoOpenOnContentEditable: z.boolean().catch(false),
  /** Sites whose forms are chat-style questionnaires (job-portal screening bots): always open on focus and re-read the conversation. */
  chatSites: z.array(z.string()).catch(['naukri.com']),
  insertMode: z.enum(['replace', 'cursor']).catch('replace'),
  skipSearchFields: z.boolean().catch(true),
  minFieldWidth: z.number().int().min(0).max(600).catch(80),
  siteMode: z.enum(['all', 'allowlist']).catch('all'),
  blockedSites: z.array(z.string()).catch([]),
  allowedSites: z.array(z.string()).catch([]),
  highlightOnFill: z.boolean().catch(true),
  closeOnInsert: z.boolean().catch(true),
});

const CacheSchema = z.object({
  instantFacts: z.boolean().catch(true),
  history: z.boolean().catch(true),
  historyThreshold: z.number().min(0).max(1).catch(0.55),
  responseCache: z.boolean().catch(true),
  responseCacheTtlHours: z.number().min(0).max(24 * 90).catch(72),
  /** When you type/correct an answer yourself: ask to remember it, remember silently, or never. */
  learn: z.enum(['ask', 'auto', 'off']).catch('ask'),
  /** smart = verified answer + key fact (short) / Saved answers note (long); history = verified answer only. */
  learnSaveAs: z.enum(['smart', 'history']).catch('smart'),
});

const PrivacySchema = z.object({
  redactSecrets: z.boolean().catch(true),
  localOnly: z.boolean().catch(false),
  sendPageUrl: z.boolean().catch(true),
});

const AppearanceSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).catch('system'),
  accent: z.enum(['violet', 'blue', 'emerald', 'orange', 'rose', 'slate']).catch('violet'),
  density: z.enum(['comfortable', 'compact']).catch('comfortable'),
  dropdownMaxWidth: z.number().int().min(280).max(720).catch(440),
  reduceMotion: z.boolean().catch(false),
});

/** The in-page suggestion popup: position, visibility and what it shows. */
const PanelSchema = z.object({
  /** Where the popup opens relative to the field (until you drag it somewhere). */
  placement: z.enum(['auto', 'below', 'above', 'right', 'left']).catch('auto'),
  /** Drag the popup by its header. */
  draggable: z.boolean().catch(true),
  /** Remember a dragged position on this site, everywhere, or only until the page reloads. */
  rememberPosition: z.enum(['per-site', 'everywhere', 'off']).catch('per-site'),
  /** A dragged popup stays at that spot on screen, or keeps its offset from the field. */
  dragAnchor: z.enum(['screen', 'field']).catch('screen'),
  /** Start pinned: stays on screen when you click elsewhere or type, until you close it. */
  pinnedByDefault: z.boolean().catch(false),
  /** Close when focus leaves the field (ignored while pinned). */
  closeOnBlur: z.boolean().catch(true),
  /** Clicking into the field again brings the popup back after you closed it. */
  reopenOnClick: z.boolean().catch(true),
  /** Hide while you type your own answer (ignored while pinned). */
  hideWhileTyping: z.boolean().catch(true),
  maxHeight: z.number().int().min(200).max(900).catch(520),
  /** Popup opacity in percent; it becomes fully opaque while hovered. */
  opacity: z.number().int().min(50).max(100).catch(100),
  showHeader: z.boolean().catch(true),
  showActions: z.boolean().catch(true),
  showFooter: z.boolean().catch(true),
  showBadges: z.boolean().catch(true),
  showGroupLabels: z.boolean().catch(true),
  /** Alt+1…9 inserts that suggestion directly. */
  numberShortcuts: z.boolean().catch(true),
  /** Tab inserts the highlighted suggestion (otherwise Tab just moves to the next field). */
  tabAccepts: z.boolean().catch(false),
});

const DebugSchema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).catch('info'),
  console: z.boolean().catch(true),
});

export const SettingsSchema = z.object({
  version: z.number().catch(1),
  onboarded: z.boolean().catch(false),
  providers: z.array(ProviderSchema).catch(DEFAULT_PROVIDERS),
  generation: GenerationSchema.prefault(EMPTY),
  memory: MemorySchema.prefault(EMPTY),
  behavior: BehaviorSchema.prefault(EMPTY),
  cache: CacheSchema.prefault(EMPTY),
  privacy: PrivacySchema.prefault(EMPTY),
  appearance: AppearanceSchema.prefault(EMPTY),
  panel: PanelSchema.prefault(EMPTY),
  debug: DebugSchema.prefault(EMPTY),
});

export type Settings = z.infer<typeof SettingsSchema>;

export function parseSettings(raw: unknown): Settings {
  const r = SettingsSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  // Shouldn't happen thanks to .catch(), but never brick the extension.
  return SettingsSchema.parse({});
}

export const DEFAULT_SETTINGS: Settings = parseSettings({});

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(KEY);
  return parseSettings(res[KEY]);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: parseSettings(s) });
}

export async function patchSettings(fn: (s: Settings) => Settings | void): Promise<Settings> {
  const cur = await loadSettings();
  const draft = structuredClone(cur);
  const next = fn(draft) ?? draft;
  await saveSettings(next);
  return next;
}

/** Subscribe to settings changes from any context. Returns an unsubscribe fn. */
export function watchSettings(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) cb(parseSettings(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
