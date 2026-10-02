/**
 * Tolerant parsing of LLM output.
 *
 * Small and free models often wrap JSON in code fences, add prose, stop early,
 * or ignore JSON entirely. Fallbacks, in order:
 *   1. strict JSON
 *   2. JSON inside ``` fences or between the first "{" and the last "}"
 *   3. partial JSON (also used while streaming)
 *   4. treat plain text as a single suggestion
 */

import { parse as parsePartial, Allow } from 'partial-json';

export interface ParsedSuggestion {
  title: string;
  text: string;
}

function stripFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)(```|$)/i);
  return m ? m[1] : s;
}

function extractObject(s: string): string {
  const start = s.indexOf('{');
  if (start < 0) return s;
  const end = s.lastIndexOf('}');
  return end > start ? s.slice(start, end + 1) : s.slice(start);
}

export function parseJsonLoose(raw: string, partial = false): unknown {
  const unfenced = stripFences(raw.trim()).trim();
  const body = unfenced.startsWith('[') ? unfenced : extractObject(unfenced);
  try {
    return JSON.parse(body);
  } catch {
    try {
      return parsePartial(body, partial ? Allow.ALL : Allow.ALL & ~Allow.STR);
    } catch {
      try {
        return parsePartial(body, Allow.ALL);
      } catch {
        return null;
      }
    }
  }
}

/** Clean up one suggestion text: remove wrapping quotes/markdown and boilerplate. */
export function cleanSuggestion(text: string): string {
  let t = text.trim();
  t = t.replace(/^(here('s| is)( an?| the)? (answer|suggestion|response)[^:]*:\s*)/i, '');
  if (/^["“'].*["”']$/s.test(t) && t.length > 2) t = t.slice(1, -1).trim();
  t = t.replace(/^\*\*(.*)\*\*$/s, '$1').replace(/\\n/g, '\n');
  return t;
}

export function normalizeSuggestions(obj: unknown): { items: ParsedSuggestion[]; missing: string } {
  const o = (obj ?? {}) as Record<string, unknown>;
  let arr: unknown[] = [];
  if (Array.isArray(o)) arr = o;
  else if (Array.isArray(o.suggestions)) arr = o.suggestions;
  else if (Array.isArray(o.options)) arr = o.options;
  else if (typeof o.text === 'string' || typeof o.answer === 'string' || typeof o.value === 'string') arr = [o];

  const items: ParsedSuggestion[] = [];
  for (const it of arr) {
    if (typeof it === 'string') items.push({ title: '', text: cleanSuggestion(it) });
    else if (it && typeof it === 'object') {
      const r = it as Record<string, unknown>;
      const text = (r.text ?? r.value ?? r.answer ?? r.content) as unknown;
      if (typeof text === 'string') items.push({ title: typeof r.title === 'string' ? r.title.trim() : '', text: cleanSuggestion(text) });
    }
  }
  const seen = new Set<string>();
  const dedup = items.filter((i) => {
    const k = i.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { items: dedup, missing: typeof o.missing === 'string' ? o.missing.trim() : '' };
}

/** Final parse of a complete response. */
export function parseSuggestions(raw: string): { items: ParsedSuggestion[]; missing: string; json: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { items: [], missing: '', json: false };
  const obj = parseJsonLoose(trimmed);
  if (obj && typeof obj === 'object') {
    const n = normalizeSuggestions(obj);
    if (n.items.length || n.missing || 'suggestions' in (obj as object)) return { ...n, json: true };
  }
  // Model ignored the format: use the whole text as one suggestion.
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { items: [{ title: '', text: cleanSuggestion(trimmed) }], missing: '', json: false };
  return { items: [], missing: '', json: false };
}

/** Parse while streaming, keeping the last, possibly unfinished, string. */
export function parseSuggestionsPartial(raw: string): ParsedSuggestion[] {
  const t = raw.trim();
  if (!t.startsWith('{') && !t.startsWith('```')) return t ? [{ title: '', text: t }] : [];
  const obj = parseJsonLoose(t, true);
  return obj ? normalizeSuggestions(obj).items : [];
}

export function parseBatch(raw: string): Record<string, string> {
  const obj = parseJsonLoose(raw) as Record<string, unknown> | null;
  const out: Record<string, string> = {};
  if (!obj) return out;
  const arr = Array.isArray(obj.fields) ? obj.fields : Array.isArray(obj) ? obj : null;
  if (arr) {
    for (const f of arr as Record<string, unknown>[]) {
      if (f && typeof f.id === 'string' && typeof f.value === 'string') out[f.id] = cleanSuggestion(f.value);
    }
  } else {
    // Some models return {"f1":"value",…}
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = cleanSuggestion(v);
  }
  return out;
}

export function parseFacts(raw: string): { label: string; value: string }[] {
  const obj = parseJsonLoose(raw) as Record<string, unknown> | null;
  const arr = obj && Array.isArray(obj.facts) ? obj.facts : Array.isArray(obj) ? obj : [];
  return (arr as Record<string, unknown>[])
    .filter((f) => f && typeof f.label === 'string' && typeof f.value === 'string')
    .map((f) => ({ label: (f.label as string).trim(), value: (f.value as string).trim() }))
    .filter((f) => f.label && f.value && f.value.length < 500 && !/^(n\/?a|none|unknown|not (stated|provided))$/i.test(f.value));
}
