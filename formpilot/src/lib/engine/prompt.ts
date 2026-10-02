/**
 * Prompt construction. The prompt is a compact, sectioned text block, not raw
 * HTML (see Mind2Web), and the most relevant memory comes first (see "Lost in the Middle").
 */

import type { FieldContext, PageContext, SuggestOptions } from '../types';
import type { Settings } from '../settings';
import type { RetrievedChunk } from '../memory/retrieval';
import { isFactual } from '../fields/classify';
import { truncate } from '../util';

export const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '1-3 word label describing this option' },
          text: { type: 'string', description: 'The exact text to insert into the field' },
        },
        required: ['title', 'text'],
      },
    },
    missing: { type: 'string', description: 'If information is missing from memory, what is missing. Empty otherwise.' },
  },
  required: ['suggestions'],
} as const;

export const BATCH_SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, value: { type: 'string' } },
        required: ['id', 'value'],
      },
    },
  },
  required: ['fields'],
} as const;

export const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, value: { type: 'string' } },
        required: ['label', 'value'],
      },
    },
  },
  required: ['facts'],
} as const;

const GROUNDING: Record<Settings['generation']['grounding'], string> = {
  strict:
    'Use ONLY information found in USER FACTS, USER MEMORY, or the page. If the answer is not there, return an empty "suggestions" list and explain in "missing".',
  balanced:
    'Base every answer on USER FACTS and USER MEMORY. Never invent specific personal facts (names, numbers, dates, contact details, employers, grades, credentials). For open-ended questions you may write natural, reasonable prose built on what memory says. If a factual field is not covered by memory, return an empty "suggestions" list and say what is missing in "missing".',
  creative:
    'Prefer USER FACTS and USER MEMORY. For open-ended questions you may make sensible, plausible inferences. Never fabricate contact details, IDs or numbers that are not in memory.',
};

export function systemPrompt(s: Settings): string {
  const g = s.generation;
  const lines = [
    'You are FormPilot. You write answers for web-form fields on behalf of the user.',
    '',
    'RULES',
    '1. Write AS the user (first person), ready to paste. No preamble, no surrounding quotes, no markdown, no placeholders like "[Your Name]".',
    `2. ${GROUNDING[g.grounding]}`,
    '3. LENGTH: you decide, based on the question and the field. Factual fields (name, email, phone, date, number, URL): just the value. Single-line text: a short phrase or one sentence. Multi-line / essay questions: as long as the question genuinely needs, usually 2-6 sentences, and longer only for cover letters or essays. Never exceed the max length when one is given.',
    '4. OPTIONS: give distinct options that differ meaningfully (e.g. concise vs. detailed, or different angles). For factual fields give exactly one option, unless memory holds several true candidates.',
    '5. Dropdowns: answer with exactly one of the listed option labels. Date inputs: YYYY-MM-DD. Number inputs: digits only.',
    '6. If the field already has text, improve or complete it rather than ignoring it.',
    '7. Reply in the language of the form unless told otherwise.',
    '8. Output ONLY JSON: {"suggestions":[{"title":"…","text":"…"}],"missing":""}',
  ];
  if (g.persona.trim()) lines.push('', `ABOUT THE USER: ${g.persona.trim()}`);
  if (g.customInstructions.trim()) lines.push('', `USER INSTRUCTIONS (follow these): ${g.customInstructions.trim()}`);
  return lines.join('\n');
}

function fieldTypeLabel(f: FieldContext): string {
  if (f.chat) return 'chat-style questionnaire reply box (answer the question directly and briefly, e.g. "3" or "3 years" for years of experience)';
  if (f.kind === 'select') return f.inputType === 'radio' ? 'single choice (radio buttons)' : 'dropdown (select one option)';
  if (f.kind === 'textarea') return 'multi-line text area';
  if (f.kind === 'contenteditable') return 'rich text editor (multi-line)';
  return `single-line input (type=${f.inputType})`;
}

export function fieldBlock(f: FieldContext, constraints = ''): string {
  const rows: string[] = [`Question: ${f.label || f.placeholder || f.name || '(unlabelled field)'}`, `Field type: ${fieldTypeLabel(f)}`];
  if (f.placeholder && f.placeholder !== f.label) rows.push(`Placeholder: ${f.placeholder}`);
  if (f.description) rows.push(`Help text: ${f.description}`);
  if (f.section) rows.push(`Section: ${f.section}`);
  if (f.semantic !== 'text') rows.push(`Detected meaning: ${f.semantic}`);
  const c = [f.maxLength ? `max length ${f.maxLength} characters` : '', f.required ? 'required' : '', constraints].filter(Boolean);
  if (c.length) rows.push(`Constraints: ${c.join(', ')}`);
  if (f.options?.length) rows.push(`Options: ${f.options.map((o) => o.label || o.value).slice(0, 80).join(' | ')}`);
  if (f.currentValue.trim()) rows.push(`Current value: ${truncate(f.currentValue, 1500)}`);
  return rows.join('\n');
}

function pageBlock(p: PageContext, includeText: boolean): string {
  const rows: string[] = [];
  rows.push(`Site: ${p.host}${p.title ? ` — ${p.title}` : ''}`);
  if (p.formTitle) rows.push(`Form: ${p.formTitle}`);
  if (p.otherFields.length) {
    rows.push('Already filled in this form:');
    for (const o of p.otherFields) rows.push(`- ${o.label}: ${o.value}`);
  }
  if (includeText && p.pageText) rows.push('', 'Page content (excerpt):', p.pageText);
  return rows.join('\n');
}

export function memoryBlock(chunks: RetrievedChunk[]): string {
  return chunks.map((c, i) => `[${i + 1}] (${c.docName})\n${c.text.trim()}`).join('\n\n');
}

export interface BuildInput {
  field: FieldContext;
  page: PageContext;
  facts: string;
  memory: RetrievedChunk[];
  settings: Settings;
  opts: SuggestOptions;
  constraints?: string;
}

export function buildSuggestPrompt({ field, page, facts, memory, settings, opts, constraints }: BuildInput): string {
  const g = settings.generation;
  const n = isFactual(field.semantic) || field.kind === 'select' ? 1 : g.numSuggestions;
  const length = opts.length && opts.length !== 'auto' ? opts.length : g.length;
  const parts = [
    '## FIELD',
    fieldBlock(field, constraints),
    '',
    '## PAGE',
    pageBlock(page, g.includePageContext),
    '',
    '## USER FACTS',
    facts || '(none)',
    '',
    '## USER MEMORY (most relevant first)',
    memory.length ? memoryBlock(memory) : '(empty)',
    '',
    '## PREFERENCES',
    `Tone: ${g.tone}. Length: ${length === 'auto' ? 'decide yourself' : length}. Language: ${g.language === 'auto' ? `same as the form (page lang: ${page.lang})` : g.language}.`,
  ];
  if (opts.refine?.trim()) parts.push(`Refinement request from the user: "${opts.refine.trim()}". Apply it to the answers.`);
  parts.push('', `Return up to ${n} suggestion${n > 1 ? 's' : ''} as JSON.`);
  return parts.join('\n');
}

export interface BatchField {
  id: string;
  field: FieldContext;
}

export function buildBatchPrompt(fields: BatchField[], page: PageContext, facts: string, memory: RetrievedChunk[], s: Settings): string {
  const list = fields.map(({ id, field: f }) => {
    const o: Record<string, unknown> = { id, question: f.label || f.placeholder || f.name, type: fieldTypeLabel(f) };
    if (f.description) o.help = f.description;
    if (f.maxLength) o.maxLength = f.maxLength;
    if (f.options?.length) o.options = f.options.map((x) => x.label || x.value).slice(0, 60);
    if (f.semantic !== 'text') o.meaning = f.semantic;
    return o;
  });
  return [
    'Fill in ALL of the following form fields for the user in one go.',
    'For each field return one value. Use an empty string when memory does not contain the answer for a factual field.',
    'Keep answers consistent with each other (same name, same email, …).',
    '',
    '## FIELDS (JSON)',
    JSON.stringify(list, null, 1),
    '',
    '## PAGE',
    pageBlock(page, s.generation.includePageContext),
    '',
    '## USER FACTS',
    facts || '(none)',
    '',
    '## USER MEMORY',
    memory.length ? memoryBlock(memory) : '(empty)',
    '',
    'Output ONLY JSON: {"fields":[{"id":"…","value":"…"}]}',
  ].join('\n');
}

export const FACTS_SYSTEM =
  'You extract personal and professional facts about the document owner. These are used to autofill web forms. Only extract facts that are explicitly stated. Never guess. Output ONLY JSON.';

export function buildFactsPrompt(docName: string, text: string): string {
  return [
    `Document: ${docName}`,
    '',
    'Extract short key facts as {"label","value"} pairs. Use these labels when they apply: Full name, First name, Last name, Email, Phone, Street address, City, State / Province, Postal code, Country, Date of birth, Gender, Nationality, Current company, Job title, Years of experience, LinkedIn URL, GitHub URL, Website, Highest education, University, Graduation year, Skills, Languages, Current salary, Expected salary, Notice period.',
    'You may add other clearly useful facts (e.g. "Certifications", "Visa status"). Values must be short (under 200 characters). Skip anything not stated.',
    '',
    '--- DOCUMENT START ---',
    truncate(text, 30000),
    '--- DOCUMENT END ---',
    '',
    'Output ONLY JSON: {"facts":[{"label":"…","value":"…"}]}',
  ].join('\n');
}
