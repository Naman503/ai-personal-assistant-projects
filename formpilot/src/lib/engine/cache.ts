/** Two-level response cache: in-memory LRU in front of IndexedDB with a TTL. */

import { db } from '../memory/db';

const MEM_MAX = 200;
const mem = new Map<string, { value: unknown; ts: number }>();

function memSet(key: string, value: unknown, ts: number) {
  mem.delete(key);
  mem.set(key, { value, ts });
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value!);
}

export async function cacheGet<T>(key: string, ttlMs: number): Promise<T | null> {
  const now = Date.now();
  const m = mem.get(key);
  if (m) {
    if (now - m.ts <= ttlMs) {
      memSet(key, m.value, m.ts); // refresh LRU position
      return m.value as T;
    }
    mem.delete(key);
  }
  const row = await db().cache.get(key);
  if (!row) return null;
  if (now - row.ts > ttlMs) {
    void db().cache.delete(key);
    return null;
  }
  memSet(key, row.value, row.ts);
  return row.value as T;
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  const ts = Date.now();
  memSet(key, value, ts);
  await db().cache.put({ key, value, ts });
}

export async function cachePrune(ttlMs: number): Promise<number> {
  const cutoff = Date.now() - ttlMs;
  return db().cache.where('ts').below(cutoff).delete();
}

export async function cacheClear(): Promise<void> {
  mem.clear();
  await db().cache.clear();
}

export async function cacheCount(): Promise<number> {
  return db().cache.count();
}
