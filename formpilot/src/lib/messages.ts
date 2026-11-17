/** Typed messages between contexts. */

import type { ErrorInfo, FieldContext, PageContext, Suggestion, SuggestMeta, SuggestOptions } from './types';
import type { LogEntry } from './logger';
import type { ProviderConfig } from './settings';
import type { GivenAnswer, JobInfo } from './job';

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
  | { type: 'work-history' }
  | { type: 'clear-cache'; what: 'responses' | 'history' | 'all' }
  | { type: 'open-options'; section?: string }
  | { type: 'site-toggle'; host: string; enabled: boolean }
  /** Job tracker: record a job as applied (or just saved), with the answers given on the form. */
  | { type: 'tracker-record'; kind: 'applied' | 'saved'; job: JobInfo; answers: GivenAnswer[]; recordedBy?: string }
  | { type: 'autopilot-batch-done'; result: { sent: number; dry: number; skipped: number; reason: string; pushback?: string; aiError?: string } }
  | { type: 'autopilot-progress'; text: string }
  | { type: 'autopilot-skip'; job: string; reason: string; key?: string }
  | { type: 'autopilot-rec-picked'; picked: { id: string; title: string; company: string; url: string }[] }
  | { type: 'autopilot-rec-done'; result: { picked: { id: string; title: string; company: string; url: string }[]; outcome: 'sent' | 'dry' | 'skip' | 'none'; reason: string; status?: Record<string, number>; pushback?: string; aiError?: string; single?: boolean } }
  | { type: 'autopilot-job-done'; result: { outcome: 'sent' | 'dry' | 'skip'; reason: string; pushback?: string; aiError?: string } }
  | { type: 'autopilot'; action: 'start' | 'stop' | 'pause' | 'reset' | 'status' | 'run-now' | 'resume' }
  | { type: 'outreach-done'; result: import('@/entrypoints/content/linkedin-outreach').OutreachResult }
  | { type: 'outreach'; action: 'status' | 'run-now' }
  | { type: 'portal-sync'; action: 'status' | 'run-now' }
  | { type: 'tracker-test'; url?: string }
  /** Popup: is this job already in the tracker? */
  | { type: 'tracker-lookup'; url: string; company?: string; role?: string }
  /** Popup: today's counts from the tracker (to apply, to send, follow-ups, interviews). */
  | { type: 'tracker-summary' }
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
export type CommandName = 'open-suggestions' | 'fill-form' | 'remember' | 'save-job' | 'mark-applied' | 'get-job' | 'apply-queue' | 'apply-queue-stop' | 'apply-queue-status' | 'apply-queue-skip-pause' | 'site-list' | 'site-apply' | 'naukri-rec';
export type TabCommand = { type: 'command'; name: CommandName; via?: 'shortcut' | 'context_menu' | 'toolbar' | 'autopilot'; opts?: { batch?: number; dryRun?: boolean; unattended?: boolean; autoSubmit?: boolean; cap?: number; relevant?: string[]; skipTitles?: string; pauseSec?: [number, number]; maxExpMin?: number; seen?: string[]; max?: number }; platform?: 'naukri' | 'cutshort' } | { type: 'settings-ping' } | { type: 'outreach-run'; task: import('@/entrypoints/content/linkedin-outreach').OutreachTask };

export interface Stats {
  docs: number;
  chunks: number;
  facts: number;
  history: number;
  cache: number;
  memoryChars: number;
  counters: Record<string, number>;
}
