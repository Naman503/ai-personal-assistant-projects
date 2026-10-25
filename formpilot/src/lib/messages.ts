/** Typed messages between contexts. */

import type { ErrorInfo, FieldContext, PageContext, Suggestion, SuggestMeta, SuggestOptions } from './types';
import type { LogEntry } from './logger';
import type { ProviderConfig } from './settings';

export const SUGGEST_PORT = 'fp-suggest';

// ---- Port protocol (content ⇄ background), streaming ----
export type PortRequest =
  | { type: 'suggest'; reqId: string; field: FieldContext; page: PageContext; opts: SuggestOptions; constraints?: string }
  | { type: 'cancel'; reqId: string };

export type PortEvent =
  | { type: 'instant'; reqId: string; items: Suggestion[] }
  | { type: 'status'; reqId: string; stage: 'retrieving' | 'generating' | 'streaming'; provider?: string }
  | { type: 'partial'; reqId: string; items: Suggestion[] }
  | { type: 'done'; reqId: string; items: Suggestion[]; meta: SuggestMeta }
  | { type: 'error'; reqId: string; error: ErrorInfo };

// ---- One-shot RPC (runtime.sendMessage) ----
export type RpcRequest =
  | { type: 'fill-form'; fields: { id: string; field: FieldContext }[]; page: PageContext; trigger?: FillTrigger }
  | { type: 'accept'; field: FieldContext; text: string; host: string; source: string; method?: InsertMethod; rank?: number; kind?: string }
  | { type: 'learn'; field: FieldContext; text: string; host: string; trigger?: LearnTrigger }
  | { type: 'test-provider'; providerId: string; provider?: ProviderConfig }
  | { type: 'list-models'; providerId: string; provider?: ProviderConfig }
  | { type: 'chrome-ai-status' }
  | { type: 'get-logs' }
  | { type: 'clear-logs' }
  | { type: 'log'; entry: LogEntry }
  | { type: 'memory-changed'; docId?: string; extractFacts?: boolean; docKind?: string; isNew?: boolean }
  | { type: 'extract-facts'; docId: string }
  | { type: 'search-memory'; query: string }
  | { type: 'stats' }
  | { type: 'clear-cache'; what: 'responses' | 'history' | 'all' }
  | { type: 'open-options'; section?: string }
  | { type: 'site-toggle'; host: string; enabled: boolean }
  /** Anonymous usage: an allowlisted event (lib/usage.ts CLIENT_EVENTS); the background drops anything else. */
  | { type: 'usage'; name: string; props?: Record<string, string | number | boolean> }
  /** Anonymous usage: an error in another context, by class and stack only (never the message). */
  | { type: 'usage-error'; where: 'content' | 'options' | 'popup' | 'offscreen'; name: string; stack?: string; fatal?: boolean };

export type InsertMethod = 'click' | 'enter' | 'tab' | 'alt_number';
export type FillTrigger = 'shortcut' | 'context_menu' | 'popup_menu' | 'toolbar';
export type LearnTrigger = 'ask' | 'auto' | 'button' | 'context_menu';

/** Fire-and-forget usage event from any extension page or content script (the background applies the off switch). */
export function track(name: string, props?: Record<string, string | number | boolean>): void {
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ type: 'usage', name, props } satisfies RpcRequest).catch(() => {});
  } catch {
    /* extension reloaded */
  }
}

/** Forward an uncaught error (class + stack only) to the background's usage reporter. */
export function trackError(where: 'content' | 'options' | 'popup' | 'offscreen', e: unknown, fatal = false): void {
  if (!(e instanceof Error) || e.name === 'AbortError') return;
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ type: 'usage-error', where, name: e.name, stack: e.stack, fatal } satisfies RpcRequest).catch(() => {});
  } catch {
    /* extension reloaded */
  }
}

export type RpcResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: ErrorInfo };

export async function rpc<T = unknown>(req: RpcRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as RpcResponse<T> | undefined;
  if (!res) throw new Error('No response from background (is the extension reloaded?)');
  if (!res.ok) {
    const e = new Error(res.error.message) as Error & { info?: ErrorInfo };
    e.info = res.error;
    throw e;
  }
  return res.data;
}

// ---- Background → content (tabs.sendMessage) ----
export type CommandName = 'open-suggestions' | 'fill-form' | 'remember';
export type TabCommand = { type: 'command'; name: CommandName; via?: 'shortcut' | 'context_menu' | 'toolbar' } | { type: 'settings-ping' };

export interface Stats {
  docs: number;
  chunks: number;
  facts: number;
  history: number;
  cache: number;
  memoryChars: number;
  counters: Record<string, number>;
}
