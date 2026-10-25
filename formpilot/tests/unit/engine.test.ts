import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuggestEngine } from '@/lib/engine/suggest';
import { recordAccepted, matchHistory, invalidateHistoryCache, signature } from '@/lib/engine/history';
import { cacheClear, cacheGet, cacheSet } from '@/lib/engine/cache';
import { buildSuggestPrompt, systemPrompt } from '@/lib/engine/prompt';
import { db, bumpMemoryVersion } from '@/lib/memory/db';
import { addDocument } from '@/lib/memory/ingest';
import { DEFAULTS, providerFromPreset } from '@/lib/settings-core';
import { resetCooldowns } from '@/lib/llm/registry';
import type { PortEvent } from '@/lib/messages';
import type { FieldContext, PageContext } from '@/lib/types';

const field = (p: Partial<FieldContext> = {}): FieldContext => ({
  fid: 'f1',
  kind: 'textarea',
  inputType: 'textarea',
  label: 'Why do you want to join Acme?',
  name: 'why',
  htmlId: 'why',
  placeholder: '',
  autocomplete: '',
  description: '',
  section: '',
  required: true,
  currentValue: '',
  semantic: 'motivation',
  longForm: true,
  ...p,
});
const page: PageContext = { url: 'https://acme.dev/jobs/1', host: 'acme.dev', title: 'Senior Engineer', lang: 'en', formTitle: 'Apply', pageText: 'We build tools for developers.', otherFields: [] };

function settings() {
  const s = structuredClone(DEFAULTS);
  s.providers = [{ ...providerFromPreset('groq'), apiKey: 'k' }];
  s.generation.streaming = false;
  s.generation.maxRetries = 0;
  return s;
}

function aiResponse(texts: string[]) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: texts.map((t, i) => ({ title: `Option ${i + 1}`, text: t })) }) } }] }), { status: 200 });
}

async function run(engine: SuggestEngine, f: FieldContext, opts = {}) {
  const events: PortEvent[] = [];
  await engine.suggest('r1', f, page, opts, new AbortController().signal, (e) => events.push(e));
  return events;
}

beforeEach(async () => {
  await Promise.all([db().docs.clear(), db().chunks.clear(), db().facts.clear(), db().history.clear(), db().kv.clear()]);
  await cacheClear();
  invalidateHistoryCache();
  resetCooldowns();
});
afterEach(() => vi.unstubAllGlobals());

describe('SuggestEngine', () => {
  it('streams instant → status → done with AI suggestions grounded in memory', async () => {
    await addDocument({ name: 'resume.pdf', type: 'pdf', text: 'Jane Doe — 6 years of React and developer tooling.' }, { chunkSize: 500, chunkOverlap: 0 });
    const fetchMock = vi.fn(async () => aiResponse(['I love developer tools.', 'Acme builds the tools I use daily.']));
    vi.stubGlobal('fetch', fetchMock);
    const s = settings();
    const engine = new SuggestEngine(() => s);
    const events = await run(engine, field());
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('instant');
    expect(types).toContain('status');
    expect(types.at(-1)).toBe('done');
    const done = events.at(-1) as Extract<PortEvent, { type: 'done' }>;
    expect(done.items.map((i) => i.text)).toEqual(['I love developer tools.', 'Acme builds the tools I use daily.']);
    expect(done.meta.provider).toBe('Groq (free tier)');
    expect(done.meta.memoryHits?.[0].doc).toBe('resume.pdf');
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.messages[1].content).toContain('6 years of React');
    expect(sent.messages[1].content).toContain('We build tools for developers.');
  });

  it('serves the second identical request from cache without calling the model', async () => {
    const fetchMock = vi.fn(async () => aiResponse(['Cached answer']));
    vi.stubGlobal('fetch', fetchMock);
    const s = settings();
    const engine = new SuggestEngine(() => s);
    await run(engine, field());
    const events = await run(engine, field());
    const done = events.at(-1) as Extract<PortEvent, { type: 'done' }>;
    expect(done.meta.cached).toBe(true);
    expect(done.items[0].text).toBe('Cached answer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers factual fields from facts instantly and skips the model', async () => {
    await db().facts.put({ id: 'x', key: 'email', label: 'Email', value: 'jane@doe.dev', source: 'manual', updatedAt: 1 });
    await bumpMemoryVersion();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const s = settings();
    const events = await run(new SuggestEngine(() => s), field({ kind: 'input', inputType: 'email', label: 'Email', semantic: 'email', longForm: false }));
    expect(events[0]).toMatchObject({ type: 'instant', items: [{ text: 'jane@doe.dev', source: 'fact' }] });
    expect(events.at(-1)).toMatchObject({ type: 'done', items: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses sensitive fields', async () => {
    const s = settings();
    const events = await run(new SuggestEngine(() => s), field({ label: 'Card number', semantic: 'cc-number' }));
    expect(events).toEqual([expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 'blocked' }) })]);
  });

  it('emits a typed error with a hint when no provider is configured', async () => {
    const s = settings();
    s.providers = [];
    const events = await run(new SuggestEngine(() => s), field());
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'no-provider' } });
    expect((events.at(-1) as Extract<PortEvent, { type: 'error' }>).error.hint).toBeTruthy();
  });

  it('clamps suggestions to maxlength', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => aiResponse(['one two three four five six seven eight nine ten'])));
    const s = settings();
    const events = await run(new SuggestEngine(() => s), field({ maxLength: 20 }));
    const done = events.at(-1) as Extract<PortEvent, { type: 'done' }>;
    expect(done.items[0].text.length).toBeLessThanOrEqual(20);
  });

  it('fill-form answers facts locally and batches the rest', async () => {
    await db().facts.put({ id: 'x', key: 'email', label: 'Email', value: 'jane@doe.dev', source: 'manual', updatedAt: 1 });
    await bumpMemoryVersion();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"fields":[{"id":"b","value":"Because tools."}]}' } }] })));
    vi.stubGlobal('fetch', fetchMock);
    const s = settings();
    const r = await new SuggestEngine(() => s).fillForm(
      [
        { id: 'a', field: field({ kind: 'input', label: 'Email', semantic: 'email', longForm: false }) },
        { id: 'b', field: field() },
        { id: 'c', field: field({ label: 'Password', semantic: 'password' }) },
      ],
      page,
      new AbortController().signal,
    );
    expect(r.values).toEqual({ a: 'jane@doe.dev', b: 'Because tools.' });
    expect(r.sources).toEqual({ a: 'fact', b: 'ai' });
    const prompt = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).messages[1].content;
    expect(prompt).not.toContain('Password');
  });
});

describe('history & cache', () => {
  it('learns accepted answers and matches similar questions on other sites', async () => {
    await recordAccepted(field({ label: 'What is your notice period?', semantic: 'notice-period' }), '30 days', 'a.com');
    invalidateHistoryCache();
    const m = await matchHistory(field({ label: 'Notice period', semantic: 'notice-period' }), 0.55);
    expect(m[0]).toMatchObject({ text: '30 days', source: 'history' });
    await recordAccepted(field({ label: 'What is your notice period?', semantic: 'notice-period' }), '30 days', 'b.com');
    expect((await db().history.toArray())[0].count).toBe(2);
    expect(signature(field({ label: 'Notice Period:' }))).toBe(signature(field({ label: 'notice period' })));
  });
  it('cache honours TTL', async () => {
    await cacheSet('k', { a: 1 });
    expect(await cacheGet('k', 10_000)).toEqual({ a: 1 });
    expect(await cacheGet('k', -1)).toBeNull();
  });
});

describe('prompt', () => {
  it('includes rules, field constraints, refine and options', () => {
    const s = settings();
    s.generation.persona = 'Backend dev';
    const p = buildSuggestPrompt({
      field: field({ kind: 'select', label: 'Country', options: [{ value: 'in', label: 'India' }], maxLength: 50 }),
      page,
      facts: '- Email: x',
      memory: [{ id: '1', docId: 'd', docName: 'cv.pdf', text: 'Lives in Pune', score: 1 }],
      settings: s,
      opts: { refine: 'be brief' },
    });
    expect(p).toContain('Options: India');
    expect(p).toContain('max length 50 characters');
    expect(p).toContain('[1] (cv.pdf)');
    expect(p).toContain('be brief');
    expect(p).toContain('Return up to 1 suggestion as JSON');
    expect(systemPrompt(s)).toContain('ABOUT THE USER: Backend dev');
    expect(systemPrompt(s)).toContain('LENGTH: you decide');
  });
});

describe('learning from corrections', () => {
  it('short answer → verified answer + key fact; next time answered instantly with no AI call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const s = settings();
    const engine = new SuggestEngine(() => s);
    const q = field({ kind: 'input', label: 'How many years of experience do you have in Postgresql?', semantic: 'text', longForm: false, chat: true });
    const r = await engine.learn(q, '6', 'naukri.com');
    expect(r.savedAs).toEqual(['answer', 'fact']);
    const fact = (await db().facts.toArray())[0];
    expect(fact).toMatchObject({ value: '6', source: 'learned', label: 'How many years of experience do you have in Postgresql?' });

    const events = await run(engine, q);
    expect(events[0]).toMatchObject({ type: 'instant', items: [expect.objectContaining({ text: '6', verified: true, title: 'Your saved answer' })] });
    expect(events.at(-1)).toMatchObject({ type: 'done', meta: { note: 'Your saved answer' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a new correction replaces the old one (fact updated, only one verified answer)', async () => {
    const s = settings();
    const engine = new SuggestEngine(() => s);
    const q = field({ kind: 'input', label: 'Notice period', semantic: 'notice-period', longForm: false });
    await engine.learn(q, '60 days', 'a.com');
    await engine.learn(q, '30 days', 'a.com');
    const facts = await db().facts.toArray();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ key: 'notice-period', label: 'Notice period', value: '30 days' });
    const verified = (await db().history.toArray()).filter((h) => h.verified);
    expect(verified.map((h) => h.answer)).toEqual(['30 days']);
    const m = await matchHistory(q, 0.55);
    expect(m[0].text).toBe('30 days');
  });

  it('long answers go to the "Saved answers" note, replacing an earlier answer to the same question', async () => {
    const s = settings();
    const engine = new SuggestEngine(() => s);
    const q = field();
    const long1 = 'I have used Acme tools for years and want to help build them. '.repeat(4);
    const long2 = 'Acme is where developer experience is taken seriously, and I want to be part of it. '.repeat(3);
    expect((await engine.learn(q, long1, 'acme.dev')).savedAs).toEqual(['answer', 'note']);
    await engine.learn(q, long2, 'acme.dev');
    const doc = await db().docs.get('doc_saved_answers');
    expect(doc?.name).toBe('Saved answers');
    expect(doc?.text).toContain(long2.trim());
    expect(doc?.text).not.toContain(long1.trim());
    expect(doc?.text.match(/Q: Why do you want to join Acme\?/g)).toHaveLength(1);
    expect(await db().chunks.where('docId').equals('doc_saved_answers').count()).toBeGreaterThan(0);
  });

  it('"answer only" mode does not touch facts or notes; sensitive fields are never saved', async () => {
    const s = settings();
    const engine = new SuggestEngine(() => s);
    await engine.learn(field({ label: 'City', semantic: 'address-level2', longForm: false }), 'Pune', 'x', 'history');
    expect(await db().facts.count()).toBe(0);
    expect(await db().history.count()).toBe(1);
    expect((await engine.learn(field({ label: 'Password', semantic: 'password' }), 'hunter2', 'x')).savedAs).toEqual([]);
    expect(await db().history.count()).toBe(1);
  });

  it('a merely similar question does not skip the AI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => aiResponse(['AI answer'])));
    const s = settings();
    const engine = new SuggestEngine(() => s);
    await engine.learn(field({ label: 'Years of experience in Postgresql?', semantic: 'text', longForm: false }), '6', 'x', 'history');
    const events = await run(engine, field({ label: 'Years of experience in MySQL?', semantic: 'text', longForm: false }));
    expect(events.at(-1)).toMatchObject({ type: 'done', items: [expect.objectContaining({ text: 'AI answer' })] });
  });
});

describe('usage telemetry from the engine', () => {
  const recorder = () => {
    const calls: { name: string; props?: Record<string, unknown> }[] = [];
    return {
      calls,
      tel: { count: (name: string, props?: Record<string, unknown>) => void calls.push({ name, props }), event: (name: string, props?: Record<string, unknown>) => void calls.push({ name, props }) },
    };
  };

  it('reports requests, outcomes, cache hits and latency buckets: never text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => aiResponse(['My secret answer'])));
    const s = settings();
    const { calls, tel } = recorder();
    const engine = new SuggestEngine(() => s, tel);
    await run(engine, field(), { kind: 'initial' });
    await run(engine, field(), { kind: 'initial' });
    const names = calls.map((c) => c.name);
    expect(names.filter((n) => n === 'suggestions_requested')).toHaveLength(2);
    expect(calls).toContainEqual({ name: 'suggest_result', props: { outcome: 'ai', kind: 'initial', provider: 'groq' } });
    expect(calls).toContainEqual({ name: 'suggest_result', props: { outcome: 'cache', kind: 'initial' } });
    expect(calls).toContainEqual({ name: 'response_cache', props: { result: 'hit' } });
    expect(calls.find((c) => c.name === 'ai_latency')?.props).toMatchObject({ op: 'suggest', provider: 'groq', bucket: expect.any(String) });
    expect(JSON.stringify(calls)).not.toMatch(/secret|Acme|groq\.com/);
  });

  it('reports errors by category, and blocked fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"slow down"}}', { status: 429 })));
    const s = settings();
    const { calls, tel } = recorder();
    const engine = new SuggestEngine(() => s, tel);
    await run(engine, field(), { kind: 'regenerate', fresh: true });
    expect(calls).toContainEqual({ name: 'ai_error', props: { op: 'suggest', category: 'rate_limit', provider: 'groq' } });
    expect(calls).toContainEqual({ name: 'suggest_result', props: { outcome: 'error', kind: 'regenerate' } });
    await run(engine, field({ label: 'Card number', semantic: 'cc-number' }));
    expect(calls).toContainEqual({ name: 'suggest_result', props: { outcome: 'blocked', kind: 'initial' } });
  });

  it('counts instant lookups as hit or miss', async () => {
    const s = settings();
    const { calls, tel } = recorder();
    await run(new SuggestEngine(() => s, tel), field(), { instantOnly: true, trigger: 'icon' });
    expect(calls).toEqual([{ name: 'instant_lookup', props: { result: 'miss' } }]);
  });
});
