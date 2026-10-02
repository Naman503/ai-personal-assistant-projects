import { beforeEach, describe, expect, it } from 'vitest';
import { chunkText, cleanText } from '@/lib/memory/chunker';
import { MemoryIndex, cosine, fieldQuery, rrf, tokenize } from '@/lib/memory/retrieval';
import { addDocument, removeDocument, setDocumentEnabled } from '@/lib/memory/ingest';
import { canonicalKey, factsBlock, matchFacts } from '@/lib/memory/facts';
import { db, type Fact } from '@/lib/memory/db';
import type { FieldContext } from '@/lib/types';

const field = (p: Partial<FieldContext>): FieldContext => ({
  fid: 'f1',
  kind: 'input',
  inputType: 'text',
  label: '',
  name: '',
  htmlId: '',
  placeholder: '',
  autocomplete: '',
  description: '',
  section: '',
  required: false,
  currentValue: '',
  semantic: 'text',
  longForm: false,
  ...p,
});

beforeEach(async () => {
  await Promise.all([db().docs.clear(), db().chunks.clear(), db().facts.clear(), db().kv.clear()]);
});

describe('chunker', () => {
  it('cleans PDF artefacts', () => {
    expect(cleanText('Hello\r\nwor-\nld\t\tagain\n\n\n\nend')).toBe('Hello\nworld again\n\nend');
  });
  it('keeps short text as one chunk', () => {
    expect(chunkText('short', { size: 100, overlap: 10 })).toEqual(['short']);
  });
  it('splits long text with bounded size and overlap', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about topic ${i}.`).join(' ');
    const chunks = chunkText(text, { size: 200, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(260);
    // overlap: consecutive chunks share some words
    const a = new Set(chunks[0].split(' '));
    expect(chunks[1].split(' ').some((w) => a.has(w))).toBe(true);
  });
});

describe('retrieval', () => {
  it('tokenize drops stopwords but keeps emails', () => {
    expect(tokenize('What is your email? jane@x.com')).toEqual(['email', 'jane@x.com']);
  });
  it('cosine + rrf', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    const fused = rrf([
      ['a', 'b', 'c'],
      ['c', 'a'],
    ]);
    expect([...fused.entries()].sort((x, y) => y[1] - x[1])[0][0]).toBe('a');
  });
  it('sends whole docs when memory is small, retrieves chunks when large', async () => {
    const idx = new MemoryIndex();
    await addDocument({ name: 'resume.pdf', type: 'pdf', text: 'Jane Doe. Senior React engineer at Acme for 5 years. Led migration to TypeScript.' }, { chunkSize: 300, chunkOverlap: 0 });
    let r = await idx.search('react experience', { topK: 3, budget: 5000 });
    expect(r.whole).toBe(true);
    expect(r.chunks[0].docName).toBe('resume.pdf');

    const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about gardening, cooking and travel to place ${i}.`).join('\n\n');
    await addDocument({ name: 'notes.txt', type: 'txt', text: filler + '\n\nMy notice period is 30 days.' }, { chunkSize: 300, chunkOverlap: 0 });
    r = await idx.search('notice period', { topK: 2, budget: 600 });
    expect(r.whole).toBe(false);
    expect(r.chunks[0].text).toContain('notice period');
  });
  it('disabled and deleted docs are excluded', async () => {
    const idx = new MemoryIndex();
    const d = await addDocument({ name: 'a.txt', type: 'txt', text: 'zebra facts' }, { chunkSize: 300, chunkOverlap: 0 });
    expect((await idx.search('zebra', { topK: 3, budget: 5000 })).chunks).toHaveLength(1);
    await setDocumentEnabled(d.id, false);
    expect((await idx.search('zebra', { topK: 3, budget: 5000 })).chunks).toHaveLength(0);
    await removeDocument(d.id);
    expect(await db().chunks.count()).toBe(0);
  });
  it('fieldQuery combines signals', () => {
    expect(fieldQuery({ label: 'Why us', description: 'be specific', placeholder: '', section: 'Motivation', semantic: 'motivation' })).toBe('Why us be specific Motivation motivation');
  });
});

describe('facts', () => {
  const facts: Fact[] = [
    { id: '1', key: 'email', label: 'Email', value: 'jane@doe.dev', source: 'manual', updatedAt: 2 },
    { id: '2', key: 'name', label: 'Full name', value: 'Jane Q Doe', source: 'extracted', updatedAt: 1 },
    { id: '3', key: 'visa-status', label: 'Visa status', value: 'H1B', source: 'manual', updatedAt: 1 },
  ];
  it('matches by semantic type', () => {
    expect(matchFacts(field({ label: 'Email address', semantic: 'email' }), facts)[0].text).toBe('jane@doe.dev');
  });
  it('matches custom facts by label tokens', () => {
    expect(matchFacts(field({ label: 'What is your current visa status?' }), facts)[0]?.text).toBe('H1B');
  });
  it('derives first/last name from full name', () => {
    expect(matchFacts(field({ label: 'First name', semantic: 'given-name' }), facts)[0].text).toBe('Jane');
    expect(matchFacts(field({ label: 'Last name', semantic: 'family-name' }), facts)[0].text).toBe('Q Doe');
  });
  it('does not answer long-form questions with loose fact matches', () => {
    expect(matchFacts(field({ label: 'Describe your visa status and relocation plans', longForm: true }), facts)).toHaveLength(0);
  });
  it('canonicalKey + factsBlock', () => {
    expect(canonicalKey('E-mail')).toBe('email');
    expect(canonicalKey('Mobile Number')).toBe('tel');
    expect(canonicalKey('Visa status')).toBe('visa-status');
    expect(factsBlock(facts)).toContain('- Email: jane@doe.dev');
  });
});
