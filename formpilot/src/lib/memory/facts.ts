/**
 * Facts are short key/value pairs (Email → jane@x.com). They are either typed
 * in by the user or extracted from documents by the LLM once at upload time.
 * Matching a field against facts takes no network call, so common fields like
 * name/email/phone fill instantly.
 */

import type { FieldContext, Suggestion } from '../types';
import type { Fact } from './db';
import { normalizeText, uid } from '../util';
import { tokenize } from './retrieval';

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Aliases that let a free-form fact key match a semantic type. */
const KEY_ALIASES: Record<string, string[]> = {
  name: ['full name', 'name'],
  'given-name': ['first name', 'given name'],
  'family-name': ['last name', 'surname', 'family name'],
  email: ['email', 'email address', 'e mail'],
  tel: ['phone', 'phone number', 'mobile', 'mobile number', 'contact number'],
  'street-address': ['address', 'street address', 'home address'],
  'address-level2': ['city', 'town'],
  'address-level1': ['state', 'province'],
  'postal-code': ['zip', 'postal code', 'pin code', 'pincode', 'zip code'],
  country: ['country'],
  organization: ['company', 'current company', 'employer', 'organization'],
  'organization-title': ['job title', 'title', 'designation', 'role', 'current role'],
  linkedin: ['linkedin', 'linkedin url', 'linkedin profile'],
  github: ['github', 'github url'],
  url: ['website', 'portfolio', 'personal website'],
  bday: ['date of birth', 'birthday', 'dob'],
  'salary-current': ['current salary', 'current ctc', 'ctc'],
  'salary-expected': ['expected salary', 'expected ctc'],
  'notice-period': ['notice period'],
  'experience-years': ['years of experience', 'total experience', 'experience'],
};

export function canonicalKey(keyOrLabel: string): string {
  const n = normalizeText(keyOrLabel);
  for (const [k, aliases] of Object.entries(KEY_ALIASES)) {
    if (n === k || aliases.includes(n)) return k;
  }
  return n.replace(/\s+/g, '-');
}

function derived(field: FieldContext, facts: Fact[]): { value: string; label: string }[] {
  const by = (k: string) => facts.find((f) => f.key === k)?.value;
  const out: { value: string; label: string }[] = [];
  const full = by('name');
  if (field.semantic === 'given-name' && full) out.push({ value: full.split(/\s+/)[0], label: 'From full name' });
  if (field.semantic === 'family-name' && full && full.includes(' '))
    out.push({ value: full.split(/\s+/).slice(1).join(' '), label: 'From full name' });
  if (field.semantic === 'name' && !full && by('given-name'))
    out.push({ value: [by('given-name'), by('family-name')].filter(Boolean).join(' '), label: 'From first + last name' });
  return out;
}

export function matchFacts(field: FieldContext, facts: Fact[], max = 3): Suggestion[] {
  if (!facts.length) return [];
  const scored: { f: Fact; s: number }[] = [];
  const fieldTokens = tokenize(`${field.label} ${field.placeholder}`);
  for (const f of facts) {
    if (!f.value.trim()) continue;
    let s = 0;
    if (field.semantic !== 'text' && f.key === field.semantic) s = 1;
    else {
      const lt = tokenize(f.label || f.key.replace(/-/g, ' '));
      s = jaccard(fieldTokens, lt);
      // A full-token containment of the fact label in the field label is a strong signal ("Your LinkedIn profile URL").
      if (lt.length && lt.every((t) => fieldTokens.includes(t))) s = Math.max(s, 0.75);
    }
    if (s >= 0.5) scored.push({ f, s });
  }
  scored.sort((a, b) => b.s - a.s || b.f.updatedAt - a.f.updatedAt);
  const out: Suggestion[] = scored.slice(0, max).map(({ f, s }) => ({
    id: uid('s'),
    text: f.value,
    source: 'fact',
    title: f.label || f.key,
    score: s,
  }));
  if (!out.length) {
    for (const d of derived(field, facts)) out.push({ id: uid('s'), text: d.value, source: 'fact', title: d.label, score: 0.9 });
  }
  // Long-form questions shouldn't be answered by a single short fact unless it's an exact match.
  return field.longForm ? out.filter((x) => (x.score ?? 0) >= 0.99) : out;
}

/** Render facts compactly for the prompt. */
export function factsBlock(facts: Fact[], maxChars = 2500): string {
  let out = '';
  for (const f of facts) {
    const line = `- ${f.label || f.key}: ${f.value.replace(/\s+/g, ' ').trim()}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out.trim();
}
