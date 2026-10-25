/** Shared data shapes passed between content script, background and UI. */

export type FieldKind = 'input' | 'textarea' | 'contenteditable' | 'select';

export interface FieldOption {
  value: string;
  label: string;
}

/** Everything we know about one form field, extracted in the page. */
export interface FieldContext {
  /** Stable per-page id (also set as data-formpilot-id on the element). */
  fid: string;
  kind: FieldKind;
  inputType: string;
  /** Best human-readable question for this field. */
  label: string;
  name: string;
  htmlId: string;
  placeholder: string;
  autocomplete: string;
  /** Help text: aria-describedby, hint elements. */
  description: string;
  /** Fieldset legend / nearest heading. */
  section: string;
  maxLength?: number;
  required: boolean;
  options?: FieldOption[];
  currentValue: string;
  /** Classified semantic type, e.g. "email", "given-name", "cover-letter". */
  semantic: string;
  /** Whether this field is long-form (textarea / rich editor / essay question). */
  longForm: boolean;
  /** Chat-style questionnaire: the question is the latest message, not a label. */
  chat?: boolean;
}

export interface PageContext {
  url: string;
  host: string;
  title: string;
  lang: string;
  formTitle: string;
  /** Visible text of the main content (job description, instructions…), truncated. */
  pageText: string;
  /** Other fields in the same form that already have values. */
  otherFields: { label: string; value: string }[];
}

export type SuggestionSource = 'fact' | 'history' | 'ai' | 'cache';

export interface Suggestion {
  id: string;
  text: string;
  source: SuggestionSource;
  /** Short label shown above the text, e.g. "Concise", "From resume.pdf". */
  title?: string;
  score?: number;
  /** A saved/corrected answer the user confirmed. */
  verified?: boolean;
}

export interface SuggestMeta {
  provider?: string;
  model?: string;
  ms?: number;
  cached?: boolean;
  memoryHits?: { doc: string; score: number }[];
  note?: string;
}

export interface ErrorInfo {
  code:
    | 'no-provider'
    | 'auth'
    | 'rate-limit'
    | 'network'
    | 'timeout'
    | 'bad-response'
    | 'unavailable'
    | 'cors'
    | 'blocked'
    | 'locked'
    | 'unknown';
  message: string;
  hint?: string;
  provider?: string;
}

export interface SuggestOptions {
  refine?: string;
  length?: 'auto' | 'short' | 'medium' | 'long';
  /** Skip caches and ask the model again. */
  fresh?: boolean;
  /** Only return instant (facts/history) results. */
  instantOnly?: boolean;
  /** Usage reporting only: what asked for this request (never sent to a model). */
  kind?: RequestKind;
  /** Usage reporting only: how the popup was opened (sent with the instant lookup). */
  trigger?: OpenTrigger;
}

export type RequestKind = 'initial' | 'manual' | 'regenerate' | 'shorter' | 'longer' | 'formal' | 'casual' | 'refine' | 'retry';
export type OpenTrigger = 'auto' | 'icon' | 'shortcut' | 'context_menu' | 'alt_down' | 'click_reopen' | 'chat_question';
