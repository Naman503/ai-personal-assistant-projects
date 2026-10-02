// Minimal typings for Chrome's built-in Prompt API (LanguageModel global).
// https://developer.chrome.com/docs/ai/prompt-api

type LMAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface LMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LMCreateOptions {
  initialPrompts?: LMMessage[];
  temperature?: number;
  topK?: number;
  signal?: AbortSignal;
  expectedInputs?: { type: 'text'; languages?: string[] }[];
  expectedOutputs?: { type: 'text'; languages?: string[] }[];
  monitor?: (m: EventTarget) => void;
}

interface LMPromptOptions {
  signal?: AbortSignal;
  responseConstraint?: object;
  omitResponseConstraintInput?: boolean;
}

interface LMSession {
  prompt(input: string, opts?: LMPromptOptions): Promise<string>;
  promptStreaming(input: string, opts?: LMPromptOptions): ReadableStream<string> & AsyncIterable<string>;
  clone(opts?: { signal?: AbortSignal }): Promise<LMSession>;
  destroy(): void;
  contextUsage?: number;
  contextWindow?: number;
}

interface LanguageModelStatic {
  availability(opts?: Omit<LMCreateOptions, 'signal' | 'monitor' | 'initialPrompts'>): Promise<LMAvailability>;
  create(opts?: LMCreateOptions): Promise<LMSession>;
  params?(): Promise<{ defaultTopK: number; maxTopK: number; defaultTemperature: number; maxTemperature: number }>;
}

declare const LanguageModel: LanguageModelStatic | undefined;
