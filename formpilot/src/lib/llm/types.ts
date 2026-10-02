import type { ProviderConfig } from '../settings';
import type { ErrorInfo } from '../types';

export interface LLMRequest {
  system: string;
  prompt: string;
  /** JSON schema for structured output; providers that can't enforce it just get the prompt instructions. */
  schema?: object;
  temperature: number;
  maxTokens: number;
  thinking: 'off' | 'low' | 'medium' | 'high';
  stream: boolean;
  signal: AbortSignal;
  /** Called with the full text so far on every streamed chunk. */
  onText?: (full: string) => void;
}

export interface LLMResult {
  text: string;
  model: string;
  usage?: { input?: number; output?: number };
}

/** A model as reported by a provider's live model list (fields depend on the provider). */
export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  /** Context window in tokens. */
  context?: number;
  maxOutput?: number;
  free?: boolean;
  /** USD per 1M tokens. */
  price?: { input: number; output: number };
  /** Bytes on disk (local models). */
  size?: number;
  params?: string;
  quant?: string;
  family?: string;
  owner?: string;
  installed?: boolean;
  modified?: string;
  thinking?: boolean;
}

export interface ProviderAdapter {
  generate(cfg: ProviderConfig, req: LLMRequest): Promise<LLMResult>;
  listModels(cfg: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]>;
  embed?(cfg: ProviderConfig, texts: string[], model: string, signal?: AbortSignal): Promise<number[][]>;
}

export class LLMError extends Error {
  code: ErrorInfo['code'];
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  hint?: string;
  provider?: string;

  constructor(
    code: ErrorInfo['code'],
    message: string,
    o: { status?: number; retryable?: boolean; retryAfterMs?: number; hint?: string; provider?: string } = {},
  ) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = o.status;
    this.retryable = o.retryable ?? false;
    this.retryAfterMs = o.retryAfterMs;
    this.hint = o.hint;
    this.provider = o.provider;
  }

  toInfo(): ErrorInfo {
    return { code: this.code, message: this.message, hint: this.hint, provider: this.provider };
  }
}
