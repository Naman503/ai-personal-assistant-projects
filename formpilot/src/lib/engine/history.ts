/**
 * Learns from accepted suggestions. When the same (or a very similar) question
 * shows up again on any site, the previous answer is offered instantly.
 */

import { db, type HistoryEntry } from '../memory/db';
import type { FieldContext, Suggestion } from '../types';
import { hash, normalizeText, uid } from '../util';
import { tokenize } from '../memory/retrieval';

export function questionText(f: Pick<FieldContext, 'label' | 'placeholder' | 'name'>): string {
  return normalizeText(f.label || f.placeholder || f.name);
}

export function signature(f: Pick<FieldContext, 'label' | 'placeholder' | 'name' | 'semantic'>): string {
  return hash(`${questionText(f)}|${f.semantic}`);
}

function similarity(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return a === b ? 1 : 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  // Dice coefficient: friendlier than Jaccard for short questions.
  return (2 * inter) / (A.size + B.size);
}

export async function recordAccepted(field: FieldContext, answer: string, host: string, opts: { verified?: boolean; maxPerQuestion?: number } = {}) {
  const maxPerQuestion = opts.maxPerQuestion ?? 5;
  const text = answer.trim();
  if (!text || text.length > 20000) return;
  const sig = signature(field);
  const id = `${sig}:${hash(text)}`;
  const existing = await db().history.get(id);
  if (opts.verified) {
    // A correction replaces the previous verified answer for this question.
    const prev = await db().history.where('sig').equals(sig).toArray();
    await db().history.bulkPut(prev.filter((e) => e.verified && e.id !== id).map((e) => ({ ...e, verified: false })));
  }
  if (existing) {
    await db().history.update(id, { count: existing.count + 1, lastUsed: Date.now(), host, ...(opts.verified ? { verified: true } : {}) });
  } else {
    await db().history.put({
      id,
      sig,
      question: questionText(field),
      semantic: field.semantic,
      answer: text,
      host,
      count: 1,
      lastUsed: Date.now(),
      verified: opts.verified || undefined,
    });
    // Keep only the most recent N distinct answers per question.
    const same = await db().history.where('sig').equals(sig).sortBy('lastUsed');
    if (same.length > maxPerQuestion) await db().history.bulkDelete(same.slice(0, same.length - maxPerQuestion).map((e) => e.id));
  }
}

let cache: { at: number; rows: HistoryEntry[] } | null = null;
export function invalidateHistoryCache() {
  cache = null;
}

async function allHistory(): Promise<HistoryEntry[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.rows;
  const rows = await db().history.orderBy('lastUsed').reverse().limit(5000).toArray();
  cache = { at: Date.now(), rows };
  return rows;
}

export async function matchHistory(field: FieldContext, threshold: number, max = 2): Promise<Suggestion[]> {
  const q = questionText(field);
  if (!q) return [];
  const sig = signature(field);
  const rows = await allHistory();
  const scored: { e: HistoryEntry; s: number }[] = [];
  for (const e of rows) {
    let s = e.sig === sig ? 1 : similarity(q, e.question);
    if (s < 1 && field.semantic !== 'text' && e.semantic === field.semantic) s = Math.max(s, 0.8);
    // Verified answers (user corrections) outrank everything learned implicitly.
    if (s >= threshold) scored.push({ e, s: s + Math.min(0.15, Math.log10(e.count + 1) * 0.1) + (e.verified ? 0.5 : 0) });
  }
  scored.sort((a, b) => b.s - a.s || b.e.lastUsed - a.e.lastUsed);
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const { e, s } of scored) {
    const k = normalizeText(e.answer);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      id: uid('s'),
      text: e.answer,
      source: 'history',
      title: e.verified ? 'Your saved answer' : e.count > 1 ? `Used ${e.count}×` : 'Used before',
      // Only an exact question match scores 1 (that is what lets a saved answer skip the AI).
      score: e.sig === sig ? 1 : Math.min(0.99, s),
      verified: e.verified || undefined,
    });
    if (out.length >= max) break;
  }
  return out;
}
