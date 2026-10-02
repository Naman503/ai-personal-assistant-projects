import Dexie, { type EntityTable } from 'dexie';

/**
 * IndexedDB schema (extension origin, so the service worker and the options page share it).
 */

export interface MemoryDoc {
  id: string;
  name: string;
  /** mime-ish: pdf | docx | txt | md | note | json | csv | html */
  type: string;
  size: number;
  chars: number;
  text: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Status of LLM fact extraction for this doc. */
  factsStatus?: 'pending' | 'done' | 'error' | 'skipped';
  error?: string;
}

export interface MemoryChunk {
  id: string;
  docId: string;
  idx: number;
  text: string;
  /** Optional embedding vector (Float32 stored as number[] for structured clone friendliness). */
  emb?: number[];
  embModel?: string;
}

export interface Fact {
  id: string;
  /** Semantic key (e.g. "email", "given-name") or a free-form slug. */
  key: string;
  label: string;
  value: string;
  /** manual = typed in settings, extracted = from a document, learned = saved from a correction on a form. */
  source: 'manual' | 'extracted' | 'learned';
  docId?: string;
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  /** Normalised question signature. */
  sig: string;
  question: string;
  semantic: string;
  answer: string;
  host: string;
  count: number;
  lastUsed: number;
  /** The user explicitly confirmed or typed this answer (a correction). It wins over AI. */
  verified?: boolean;
}

export interface CacheEntry {
  key: string;
  value: unknown;
  ts: number;
}

export interface KV {
  key: string;
  value: unknown;
}

export class FormPilotDB extends Dexie {
  docs!: EntityTable<MemoryDoc, 'id'>;
  chunks!: EntityTable<MemoryChunk, 'id'>;
  facts!: EntityTable<Fact, 'id'>;
  history!: EntityTable<HistoryEntry, 'id'>;
  cache!: EntityTable<CacheEntry, 'key'>;
  kv!: EntityTable<KV, 'key'>;

  constructor() {
    super('formpilot');
    this.version(1).stores({
      docs: 'id, updatedAt, enabled',
      chunks: 'id, docId',
      facts: 'id, key, docId, updatedAt',
      history: 'id, sig, semantic, lastUsed',
      cache: 'key, ts',
      kv: 'key',
    });
  }
}

let _db: FormPilotDB | null = null;
export function db(): FormPilotDB {
  if (!_db) _db = new FormPilotDB();
  return _db;
}

/** Bumped whenever docs/chunks/facts change so the background can invalidate indices. */
export async function bumpMemoryVersion(): Promise<number> {
  const cur = ((await db().kv.get('memVersion'))?.value as number) ?? 0;
  await db().kv.put({ key: 'memVersion', value: cur + 1 });
  return cur + 1;
}

export async function memoryVersion(): Promise<number> {
  return ((await db().kv.get('memVersion'))?.value as number) ?? 0;
}
