/**
 * Ollama model management from the options page: install (pull with progress), delete, version.
 * The DNR Origin rule also covers extension pages, so these calls aren't rejected with 403.
 */

import { joinUrl, readNDJSON, safeFetch, httpError } from './http';

export interface PullProgress {
  status: string;
  /** 0..1 when known. */
  ratio?: number;
  completed?: number;
  total?: number;
}

export async function ollamaVersion(baseUrl: string, signal?: AbortSignal): Promise<string> {
  const res = await safeFetch(joinUrl(baseUrl, 'api/version'), { signal }, 'Ollama');
  if (!res.ok) throw await httpError(res, 'Ollama');
  return ((await res.json()) as { version?: string }).version ?? 'unknown';
}

export async function ollamaPull(baseUrl: string, model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
  const res = await safeFetch(
    joinUrl(baseUrl, 'api/pull'),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal },
    'Ollama',
  );
  if (!res.ok) throw await httpError(res, 'Ollama');
  // Ollama reports progress per layer; track the largest layer (the weights) for a meaningful bar.
  let best = { completed: 0, total: 0 };
  await readNDJSON(
    res,
    (o) => {
      if (o.error) throw new Error(String(o.error));
      const total = Number(o.total ?? 0);
      const completed = Number(o.completed ?? 0);
      if (total >= best.total) best = { completed, total };
      onProgress({
        status: String(o.status ?? ''),
        completed: best.completed,
        total: best.total,
        ratio: best.total ? best.completed / best.total : undefined,
      });
    },
    signal,
  );
}

export async function ollamaDelete(baseUrl: string, model: string): Promise<void> {
  const res = await safeFetch(
    joinUrl(baseUrl, 'api/delete'),
    { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) },
    'Ollama',
  );
  if (!res.ok) throw await httpError(res, 'Ollama');
}
