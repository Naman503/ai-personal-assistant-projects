/**
 * Curated catalog of open models that run locally through Ollama.
 * Sizes are for the default 4-bit (Q4_K_M) tags from ollama.com/library and are
 * approximate. Installed models are always read live from Ollama (/api/tags),
 * and any other model can be installed by name.
 */

export interface LocalModel {
  tag: string;
  name: string;
  maker: string;
  params: string;
  /** Download / disk size in GB (Q4). */
  sizeGB: number;
  /** Context window in tokens. */
  context: number;
  /** Rough minimum free RAM / VRAM in GB to run comfortably. */
  ramGB: number;
  license: string;
  speed: 1 | 2 | 3 | 4 | 5;
  quality: 1 | 2 | 3 | 4 | 5;
  tags: ('recommended' | 'tiny' | 'reasoning' | 'multilingual' | 'vision' | 'coding' | 'long-context')[];
  notes: string;
}

export const LOCAL_MODELS: LocalModel[] = [
  { tag: 'qwen2.5:7b', name: 'Qwen 2.5 7B', maker: 'Alibaba', params: '7.6B', sizeGB: 4.7, context: 32768, ramGB: 8, license: 'Apache 2.0', speed: 3, quality: 4, tags: ['recommended', 'multilingual'], notes: 'Best all-rounder for forms: follows JSON instructions reliably and writes good prose.' },
  { tag: 'llama3.2:3b', name: 'Llama 3.2 3B', maker: 'Meta', params: '3.2B', sizeGB: 2.0, context: 131072, ramGB: 4, license: 'Llama 3.2 Community', speed: 4, quality: 3, tags: ['recommended', 'long-context'], notes: 'Fast on any laptop. Good for short factual fields and simple answers.' },
  { tag: 'gemma3:4b', name: 'Gemma 3 4B', maker: 'Google', params: '4.3B', sizeGB: 3.3, context: 131072, ramGB: 6, license: 'Gemma Terms', speed: 4, quality: 3, tags: ['recommended', 'multilingual', 'vision', 'long-context'], notes: 'Strong writing for its size and supports 140+ languages.' },
  { tag: 'qwen3:4b', name: 'Qwen 3 4B', maker: 'Alibaba', params: '4.0B', sizeGB: 2.5, context: 40960, ramGB: 5, license: 'Apache 2.0', speed: 4, quality: 3, tags: ['recommended', 'reasoning', 'multilingual'], notes: 'Hybrid thinking model; FormPilot strips <think> blocks automatically.' },
  { tag: 'phi4-mini', name: 'Phi-4 mini', maker: 'Microsoft', params: '3.8B', sizeGB: 2.5, context: 131072, ramGB: 5, license: 'MIT', speed: 4, quality: 3, tags: ['long-context'], notes: 'Compact and good at structured output.' },
  { tag: 'llama3.2:1b', name: 'Llama 3.2 1B', maker: 'Meta', params: '1.2B', sizeGB: 1.3, context: 131072, ramGB: 2, license: 'Llama 3.2 Community', speed: 5, quality: 2, tags: ['tiny'], notes: 'Runs almost anywhere. Fine for names and emails, weak for essays.' },
  { tag: 'gemma3:1b', name: 'Gemma 3 1B', maker: 'Google', params: '1.0B', sizeGB: 0.8, context: 32768, ramGB: 2, license: 'Gemma Terms', speed: 5, quality: 2, tags: ['tiny'], notes: 'Smallest useful model.' },
  { tag: 'qwen2.5:3b', name: 'Qwen 2.5 3B', maker: 'Alibaba', params: '3.1B', sizeGB: 1.9, context: 32768, ramGB: 4, license: 'Qwen Research', speed: 4, quality: 3, tags: ['multilingual'], notes: 'Small and good at following JSON instructions.' },
  { tag: 'llama3.1:8b', name: 'Llama 3.1 8B', maker: 'Meta', params: '8.0B', sizeGB: 4.9, context: 131072, ramGB: 8, license: 'Llama 3.1 Community', speed: 3, quality: 4, tags: ['long-context'], notes: 'Solid general model with a huge ecosystem.' },
  { tag: 'qwen3:8b', name: 'Qwen 3 8B', maker: 'Alibaba', params: '8.2B', sizeGB: 5.2, context: 40960, ramGB: 9, license: 'Apache 2.0', speed: 3, quality: 4, tags: ['reasoning', 'multilingual'], notes: 'Thinking model. Higher quality but slower first token.' },
  { tag: 'mistral:7b', name: 'Mistral 7B', maker: 'Mistral AI', params: '7.2B', sizeGB: 4.1, context: 32768, ramGB: 8, license: 'Apache 2.0', speed: 3, quality: 3, tags: [], notes: 'Classic, fast 7B model.' },
  { tag: 'gemma3:12b', name: 'Gemma 3 12B', maker: 'Google', params: '12.2B', sizeGB: 8.1, context: 131072, ramGB: 12, license: 'Gemma Terms', speed: 2, quality: 4, tags: ['multilingual', 'vision', 'long-context'], notes: 'Excellent writing quality if you have 16 GB RAM.' },
  { tag: 'qwen2.5:14b', name: 'Qwen 2.5 14B', maker: 'Alibaba', params: '14.8B', sizeGB: 9.0, context: 32768, ramGB: 14, license: 'Apache 2.0', speed: 2, quality: 5, tags: ['multilingual'], notes: 'Near cloud quality on a 16–32 GB machine.' },
  { tag: 'phi4', name: 'Phi-4 14B', maker: 'Microsoft', params: '14.7B', sizeGB: 9.1, context: 16384, ramGB: 14, license: 'MIT', speed: 2, quality: 4, tags: [], notes: 'Strong reasoning, shorter context.' },
  { tag: 'deepseek-r1:8b', name: 'DeepSeek-R1 8B', maker: 'DeepSeek', params: '8.2B', sizeGB: 5.2, context: 131072, ramGB: 9, license: 'MIT', speed: 2, quality: 3, tags: ['reasoning'], notes: 'Reasoning-focused. Slow for forms because it thinks before answering.' },
  { tag: 'gpt-oss:20b', name: 'gpt-oss 20B', maker: 'OpenAI', params: '21B (MoE, 3.6B active)', sizeGB: 14, context: 131072, ramGB: 16, license: 'Apache 2.0', speed: 3, quality: 5, tags: ['reasoning', 'long-context'], notes: 'Open-weight OpenAI model. Very capable; needs 16 GB+.' },
  { tag: 'gemma3:27b', name: 'Gemma 3 27B', maker: 'Google', params: '27.4B', sizeGB: 17, context: 131072, ramGB: 24, license: 'Gemma Terms', speed: 1, quality: 5, tags: ['multilingual', 'vision', 'long-context'], notes: 'Top quality for workstations or Apple Silicon with 32 GB+.' },
];

/** Normalise "llama3.2" → "llama3.2:latest" for comparisons. */
export function normTag(t: string): string {
  return t.includes(':') ? t : `${t}:latest`;
}

export function fmtContext(n?: number): string {
  if (!n) return '';
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1024)}K`;
}

export function fmtPrice(p?: { input: number; output: number }): string {
  if (!p) return '';
  if (p.input === 0 && p.output === 0) return 'Free';
  const f = (x: number) => (x < 0.01 ? x.toFixed(3) : x < 1 ? x.toFixed(2) : x.toFixed(1));
  return `$${f(p.input)} / $${f(p.output)} per 1M`;
}
