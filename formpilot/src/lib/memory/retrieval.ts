/**
 * Hybrid retrieval over memory chunks.
 *
 *  - Lexical: MiniSearch BM25+ with prefix and fuzzy matching. Always on, offline, about 1 ms.
 *  - Semantic (optional): cosine similarity over Gemini embeddings.
 *  - Fusion: Reciprocal Rank Fusion (k = 60), which avoids comparing scores on different scales.
 *
 * Short-circuit: if every enabled document fits in the context budget, send them
 * all. Retrieval can only lose information, so this skips it when it isn't needed.
 */

import MiniSearch from 'minisearch';
import { db, memoryVersion, type MemoryChunk, type MemoryDoc } from './db';
import { createLogger } from '../logger';

const log = createLogger('bg:retrieval');

const STOPWORDS = new Set(
  'a an the and or of to in on for with your you yours my me i is are was were be been at by from as it this that please enter provide what which who whom whose how when where why do does did have has had will would can could should may might any if about into than then there their they them we our us its'.split(
    ' ',
  ),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}@.+]+/u)
    .map((t) => t.replace(/^[.+]+|[.+]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface RetrievedChunk {
  id: string;
  docId: string;
  docName: string;
  text: string;
  score: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** True when whole docs were included instead of retrieved chunks. */
  whole: boolean;
  ms: number;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Reciprocal Rank Fusion of several ranked id lists. */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  return scores;
}

export class MemoryIndex {
  private version = -1;
  private ms: MiniSearch<MemoryChunk> | null = null;
  private chunks = new Map<string, MemoryChunk>();
  private docs = new Map<string, MemoryDoc>();
  private building: Promise<void> | null = null;

  async ensure(): Promise<void> {
    const v = await memoryVersion();
    if (v === this.version && this.ms) return;
    if (!this.building) {
      this.building = this.rebuild(v).finally(() => (this.building = null));
    }
    await this.building;
  }

  private async rebuild(v: number) {
    const end = log.time('rebuild index');
    const docs = (await db().docs.toArray()).filter((d) => d.enabled);
    const ids = new Set(docs.map((d) => d.id));
    const chunks = (await db().chunks.toArray()).filter((c) => ids.has(c.docId));
    this.docs = new Map(docs.map((d) => [d.id, d]));
    this.chunks = new Map(chunks.map((c) => [c.id, c]));
    const ms = new MiniSearch<MemoryChunk>({
      fields: ['text'],
      idField: 'id',
      tokenize: (s) => tokenize(s),
      processTerm: (t) => t,
      searchOptions: { prefix: (t) => t.length > 3, fuzzy: (t) => (t.length > 5 ? 0.2 : false), combineWith: 'OR' },
    });
    ms.addAll(chunks);
    this.ms = ms;
    this.version = v;
    end({ docs: docs.length, chunks: chunks.length });
  }

  get totalChars(): number {
    let n = 0;
    for (const d of this.docs.values()) n += d.chars;
    return n;
  }

  get docCount(): number {
    return this.docs.size;
  }

  async search(
    query: string,
    opts: { topK: number; budget: number; queryEmbedding?: number[] | null },
  ): Promise<RetrievalResult> {
    const t0 = performance.now();
    await this.ensure();
    if (!this.docs.size) return { chunks: [], whole: false, ms: 0 };

    // Small memory: include everything, most recently updated first.
    if (this.totalChars <= opts.budget) {
      const all = [...this.docs.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((d) => ({ id: d.id, docId: d.id, docName: d.name, text: d.text, score: 1 }));
      return { chunks: all, whole: true, ms: Math.round(performance.now() - t0) };
    }

    const lexical = (this.ms?.search(query) ?? []).slice(0, opts.topK * 3);
    const lists: string[][] = [lexical.map((r) => String(r.id))];

    if (opts.queryEmbedding) {
      const sem = [...this.chunks.values()]
        .filter((c) => c.emb?.length)
        .map((c) => ({ id: c.id, s: cosine(opts.queryEmbedding!, c.emb!) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, opts.topK * 3);
      if (sem.length) lists.push(sem.map((x) => x.id));
    }

    const fused = lists.length > 1 ? rrf(lists) : new Map(lexical.map((r) => [String(r.id), r.score]));
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);

    const out: RetrievedChunk[] = [];
    let used = 0;
    for (const [id, score] of ranked) {
      const c = this.chunks.get(id);
      if (!c) continue;
      if (used + c.text.length > opts.budget && out.length) break;
      out.push({ id, docId: c.docId, docName: this.docs.get(c.docId)?.name ?? 'memory', text: c.text, score });
      used += c.text.length;
      if (out.length >= opts.topK) break;
    }
    return { chunks: out, whole: false, ms: Math.round(performance.now() - t0) };
  }

  /** All chunks that still need an embedding for the given model. */
  pendingEmbeddings(model: string): MemoryChunk[] {
    return [...this.chunks.values()].filter((c) => !c.emb?.length || c.embModel !== model);
  }

  invalidate() {
    this.version = -1;
  }
}

/** Build the retrieval query for a field. */
export function fieldQuery(f: { label: string; description: string; placeholder: string; section: string; semantic: string }): string {
  return [f.label, f.description, f.placeholder, f.section, f.semantic !== 'text' ? f.semantic.replace(/-/g, ' ') : '']
    .filter(Boolean)
    .join(' ');
}
