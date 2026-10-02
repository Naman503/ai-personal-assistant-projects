/**
 * Direct Prompt API helpers. They must run in a Window context: the offscreen
 * document for generation, and the options page for status and model download.
 */

import { hash } from '../util';

const LANGS = ['en'];

export function hasPromptApi(): boolean {
  return typeof LanguageModel !== 'undefined';
}

export async function nanoAvailability(): Promise<LMAvailability | 'no-api'> {
  if (!hasPromptApi()) return 'no-api';
  try {
    return await LanguageModel!.availability({ expectedInputs: [{ type: 'text', languages: LANGS }], expectedOutputs: [{ type: 'text', languages: LANGS }] });
  } catch {
    return 'unavailable';
  }
}

/** Trigger the model download (needs a user gesture, so call it from a click handler). */
export async function nanoDownload(onProgress: (pct: number) => void): Promise<void> {
  if (!hasPromptApi()) throw new Error('The Prompt API is not available in this browser.');
  const s = await LanguageModel!.create({
    expectedInputs: [{ type: 'text', languages: LANGS }],
    expectedOutputs: [{ type: 'text', languages: LANGS }],
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => onProgress(Math.round(((e as ProgressEvent).loaded ?? 0) * 100)));
    },
  });
  s.destroy();
}

const bases = new Map<string, LMSession>();

async function baseSession(system: string, temperature: number): Promise<LMSession> {
  const key = hash(system) + ':' + temperature.toFixed(2);
  const hit = bases.get(key);
  if (hit) return hit;
  const params = await LanguageModel!.params?.().catch(() => null);
  const opts: LMCreateOptions = {
    initialPrompts: [{ role: 'system', content: system }],
    expectedInputs: [{ type: 'text', languages: LANGS }],
    expectedOutputs: [{ type: 'text', languages: LANGS }],
  };
  if (params) {
    opts.temperature = Math.min(temperature, params.maxTemperature);
    opts.topK = params.defaultTopK;
  }
  const s = await LanguageModel!.create(opts);
  // Keep a few warm base sessions (one per distinct system prompt).
  if (bases.size >= 3) {
    const [k, old] = bases.entries().next().value!;
    old.destroy();
    bases.delete(k);
  }
  bases.set(key, s);
  return s;
}

export async function nanoGenerate(
  req: { system: string; prompt: string; schema?: object; temperature: number; stream: boolean },
  signal: AbortSignal,
  onText: (t: string) => void,
): Promise<string> {
  const avail = await nanoAvailability();
  if (avail !== 'available') {
    const err = new Error(
      avail === 'no-api'
        ? 'Chrome built-in AI (Prompt API) is not available in this browser.'
        : avail === 'downloadable' || avail === 'downloading'
          ? 'Gemini Nano is not downloaded yet.'
          : 'Gemini Nano is unavailable on this device.',
    ) as Error & { code: string };
    err.code = avail === 'no-api' ? 'unavailable' : avail;
    throw err;
  }
  const base = await baseSession(req.system, req.temperature);
  // Clone so every request starts from the system prompt with no carried-over turns.
  const session = await base.clone({ signal });
  try {
    const opts: LMPromptOptions = { signal };
    if (req.schema) opts.responseConstraint = req.schema;
    if (!req.stream) {
      const t = await session.prompt(req.prompt, opts);
      onText(t);
      return t;
    }
    let full = '';
    for await (const chunk of session.promptStreaming(req.prompt, opts)) {
      // Since Chrome 128 the stream yields deltas; older builds yielded the cumulative text.
      full = chunk.startsWith(full) && full ? chunk : full + chunk;
      onText(full);
    }
    return full;
  } finally {
    session.destroy();
  }
}
