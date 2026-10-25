/**
 * The suggestion engine (runs in the background service worker).
 *
 *   instant  ── facts + history ─────────────────────────────▶ in under 30 ms, no network
 *   cache    ── hash(model + prompt) ────────────────────────▶ in under 50 ms on a repeat question
 *   AI       ── retrieve → prompt → provider chain → stream ─▶ partial results while typing
 */

import type { FieldContext, PageContext, Suggestion, SuggestMeta, SuggestOptions } from '../types';
import type { PortEvent } from '../messages';
import type { Settings } from '../settings';
import { db, memoryVersion, bumpMemoryVersion, type Fact } from '../memory/db';
import { MemoryIndex, fieldQuery, type RetrievedChunk } from '../memory/retrieval';
import { canonicalKey, factsBlock, matchFacts } from '../memory/facts';
import { matchHistory, recordAccepted, invalidateHistoryCache, questionText } from './history';
import { updateDocumentText, addDocument } from '../memory/ingest';
import { cacheGet, cacheSet } from './cache';
import { BATCH_SCHEMA, FACTS_SCHEMA, FACTS_SYSTEM, SUGGESTION_SCHEMA, buildBatchPrompt, buildFactsPrompt, buildSuggestPrompt, systemPrompt } from './prompt';
import { parseBatch, parseFacts, parseSuggestions, parseSuggestionsPartial } from './parse';
import { redactSecrets } from './redact';
import { activeProviders, adapterFor, generateWithFallback, resolveProvider } from '../llm/registry';
import { LLMError } from '../llm/types';
import { isFactual, isSensitive, semanticLabel } from '../fields/classify';
import { clampToLength, hash, isAbort, uid } from '../util';
import { createLogger } from '../logger';
import { countBucket, errorCategory, msBucket, providerFamily, type Props } from '../usage';
import type { ProviderConfig } from '../settings';

const log = createLogger('bg:engine');

export const counters: Record<string, number> = {
  requests: 0,
  instantHits: 0,
  cacheHits: 0,
  llmCalls: 0,
  errors: 0,
  accepted: 0,
};

/** Anonymous usage hooks (lib/usage.ts). Only enums, booleans and buckets go through here. */
export interface EngineTelemetry {
  count(name: string, props?: Props, n?: number): unknown;
  event(name: string, props?: Props): unknown;
}

const REQUEST_KINDS: string[] = ['initial', 'manual', 'regenerate', 'shorter', 'longer', 'formal', 'casual', 'refine', 'retry'];
const NO_TELEMETRY: EngineTelemetry = { count: () => undefined, event: () => undefined };

export class SuggestEngine {
  index = new MemoryIndex();
  private factsCache: { v: number; facts: Fact[] } | null = null;
  private queryEmb = new Map<string, number[]>();

  constructor(
    private settings: () => Settings,
    private usage: EngineTelemetry = NO_TELEMETRY,
  ) {}

  async facts(): Promise<Fact[]> {
    const v = await memoryVersion();
    if (this.factsCache?.v === v) return this.factsCache.facts;
    const facts = await db().facts.orderBy('updatedAt').reverse().toArray();
    this.factsCache = { v, facts };
    return facts;
  }

  async instant(field: FieldContext): Promise<Suggestion[]> {
    const s = this.settings();
    const history = s.cache.history ? await matchHistory(field, s.cache.historyThreshold) : [];
    const facts = s.cache.instantFacts ? matchFacts(field, await this.facts()) : [];
    // Your saved (verified) answers first, then facts, then answers used before. Dedupe keeps the first.
    const out: Suggestion[] = [...history.filter((h) => h.verified), ...facts, ...history.filter((h) => !h.verified)];
    const seen = new Set<string>();
    return out.filter((x) => {
      const k = x.text.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  private async retrieve(field: FieldContext, extraQuery = ''): Promise<{ chunks: RetrievedChunk[]; ms: number }> {
    const s = this.settings();
    if (!s.memory.enabled) return { chunks: [], ms: 0 };
    const query = `${fieldQuery(field)} ${extraQuery}`.trim();
    let queryEmbedding: number[] | null = null;
    if (s.memory.useEmbeddings) queryEmbedding = await this.embedQuery(query).catch((e) => (log.warn('query embedding failed', e), null));
    const r = await this.index.search(query, { topK: s.memory.topK, budget: s.memory.contextBudgetChars, queryEmbedding });
    log.debug(`retrieved ${r.chunks.length} ${r.whole ? 'whole docs' : 'chunks'} in ${r.ms}ms`, r.chunks.map((c) => `${c.docName} (${c.score.toFixed(3)})`));
    return r;
  }

  private embedProvider() {
    return this.settings().providers.find((p) => p.kind === 'gemini' && p.enabled && (p.apiKey.trim() || p.hasKey));
  }

  private async embedQuery(q: string): Promise<number[] | null> {
    const p = this.embedProvider();
    if (!p) return null;
    const k = hash(q);
    const hit = this.queryEmb.get(k);
    if (hit) return hit;
    const [v] = await adapterFor(p).embed!(await resolveProvider(p), [q], this.settings().memory.embeddingModel);
    if (this.queryEmb.size > 300) this.queryEmb.clear();
    if (v) this.queryEmb.set(k, v);
    return v ?? null;
  }

  /** Compute embeddings for chunks missing them (background, best-effort). */
  async embedPending(signal?: AbortSignal): Promise<number> {
    const s = this.settings();
    const p = this.embedProvider();
    if (!s.memory.useEmbeddings || !p) return 0;
    await this.index.ensure();
    const model = s.memory.embeddingModel;
    const pending = this.index.pendingEmbeddings(model);
    if (!pending.length) return 0;
    const end = log.time(`embedding ${pending.length} chunks`);
    const vecs = await adapterFor(p).embed!(await resolveProvider(p), pending.map((c) => c.text), model, signal);
    await db().chunks.bulkPut(pending.map((c, i) => ({ ...c, emb: vecs[i], embModel: model })));
    await bumpMemoryVersion();
    end();
    return pending.length;
  }

  private prepare(text: string): string {
    return this.settings().privacy.redactSecrets ? redactSecrets(text) : text;
  }

  async suggest(
    reqId: string,
    field: FieldContext,
    page: PageContext,
    opts: SuggestOptions,
    signal: AbortSignal,
    emit: (e: PortEvent) => void,
    constraints = '',
  ): Promise<void> {
    const s = this.settings();
    const t0 = performance.now();
    counters.requests++;
    const kind = REQUEST_KINDS.includes(opts.kind ?? '') ? opts.kind! : opts.refine ? 'refine' : opts.fresh ? 'regenerate' : 'initial';
    const result = (outcome: string, extra: Props = {}) => void this.usage.count('suggest_result', { outcome, kind, ...extra });
    if (!opts.instantOnly) void this.usage.count('suggestions_requested', { kind });
    log.info(`suggest "${field.label || field.name}" [${field.kind}/${field.semantic}]${opts.refine ? ` refine="${opts.refine}"` : ''}`);

    if (isSensitive(field.semantic)) {
      emit({ type: 'error', reqId, error: { code: 'blocked', message: 'FormPilot never fills sensitive fields (passwords, cards, OTP…).' } });
      result('blocked');
      return;
    }

    // 1) Instant
    let instant: Suggestion[] = [];
    if (!opts.refine && !opts.fresh) {
      instant = await this.instant(field);
      if (instant.length) counters.instantHits++;
      emit({ type: 'instant', reqId, items: instant });
      log.debug(`instant: ${instant.length} in ${Math.round(performance.now() - t0)}ms`);
      if (opts.instantOnly) void this.usage.count('instant_lookup', { result: instant.length ? 'hit' : 'miss' });
    }
    if (opts.instantOnly) return;

    // An answer you saved for exactly this question is the answer: no model call.
    const savedAnswer = instant.find((x) => x.verified && (x.score ?? 0) >= 1);
    if (savedAnswer && !opts.fresh && !opts.refine) {
      emit({ type: 'done', reqId, items: [], meta: { ms: Math.round(performance.now() - t0), note: 'Your saved answer' } });
      result('saved_answer');
      return;
    }
    // A confident fact for a short factual field is the answer, so skip the model to save time and quota.
    const exactFact = instant.find((x) => x.source === 'fact' && (x.score ?? 0) >= 1);
    if (exactFact && isFactual(field.semantic) && !field.longForm && !opts.fresh && !opts.refine) {
      emit({ type: 'done', reqId, items: [], meta: { ms: Math.round(performance.now() - t0), note: 'Answered from your facts' } });
      result('fact');
      return;
    }

    // 2) Retrieval
    emit({ type: 'status', reqId, stage: 'retrieving' });
    const { chunks } = await this.retrieve(field, page.formTitle);
    const facts = await this.facts();
    if (signal.aborted) return result('cancelled');

    const system = systemPrompt(s);
    const prompt = this.prepare(
      buildSuggestPrompt({ field, page, facts: factsBlock(facts), memory: chunks, settings: s, opts, constraints }),
    );
    const chain = activeProviders(s);
    const head = chain[0];
    const cacheKey = hash(`${head?.id}|${head?.model}|${system}|${prompt}|${s.generation.numSuggestions}`);
    const ttl = s.cache.responseCacheTtlHours * 3600_000;
    const memoryHits = dedupeDocs(chunks);
    if (s.memory.enabled) void this.usage.count('memory_retrieval', { docs: countBucket(memoryHits.length) });

    // 3) Response cache
    if (s.cache.responseCache && !opts.fresh && ttl > 0) {
      const hit = await cacheGet<{ items: Suggestion[]; provider: string; model: string }>(cacheKey, ttl);
      void this.usage.count('response_cache', { result: hit ? 'hit' : 'miss' });
      if (hit) {
        counters.cacheHits++;
        result('cache');
        const ms = Math.round(performance.now() - t0);
        log.info(`cache hit (${ms}ms)`);
        emit({ type: 'done', reqId, items: hit.items.map((i) => ({ ...i, id: uid('s') })), meta: { provider: hit.provider, model: hit.model, ms, cached: true, memoryHits } });
        return;
      }
    }

    // 4) Generate
    emit({ type: 'status', reqId, stage: 'generating', provider: head?.label });
    counters.llmCalls++;
    let lastEmit = 0;
    let streamed = false;
    const toItems = (arr: { title: string; text: string }[]): Suggestion[] =>
      arr
        .filter((x) => x.text.trim())
        .map((x, i) => ({ id: `${reqId}-${i}`, text: clampToLength(x.text, field.maxLength), source: 'ai' as const, title: x.title || undefined }));

    try {
      const r = await generateWithFallback(s, {
        system,
        prompt,
        schema: SUGGESTION_SCHEMA,
        temperature: s.generation.temperature,
        maxTokens: s.generation.maxOutputTokens,
        thinking: s.generation.thinking,
        stream: s.generation.streaming,
        signal,
        onText: (full) => {
          const now = performance.now();
          if (now - lastEmit < 70) return; // throttle UI updates
          lastEmit = now;
          const partial = parseSuggestionsPartial(full);
          if (partial.length) {
            if (!streamed) emit({ type: 'status', reqId, stage: 'streaming' });
            streamed = true;
            emit({ type: 'partial', reqId, items: toItems(partial) });
          }
        },
      });
      const parsed = parseSuggestions(r.text);
      const items = toItems(parsed.items);
      const ms = Math.round(performance.now() - t0);
      if (!parsed.json) log.warn('model did not return JSON; used raw text', r.text.slice(0, 200));
      log.info(`done: ${items.length} suggestions via ${r.provider.label} in ${ms}ms${parsed.missing ? ` (missing: ${parsed.missing})` : ''}`);
      const meta: SuggestMeta = {
        provider: r.provider.label,
        model: r.model,
        ms,
        memoryHits,
        note: parsed.missing ? `Not in your memory: ${parsed.missing}` : items.length ? undefined : 'The model returned no suggestions.',
      };
      emit({ type: 'done', reqId, items, meta });
      const provider = providerFamily(r.provider);
      result(items.length ? 'ai' : 'empty', { provider });
      void this.usage.count('ai_latency', { op: 'suggest', provider, bucket: msBucket(ms), streamed: streamed });
      if (parsed.missing) void this.usage.count('answer_missing_info');
      if (!parsed.json) void this.usage.count('ai_bad_json', { provider });
      if (r.attempts.some((a) => a.error)) void this.usage.count('provider_fallback', { to: provider, tries: r.attempts.length });
      if (items.length && s.cache.responseCache) void cacheSet(cacheKey, { items, provider: r.provider.label, model: r.model });
    } catch (e) {
      if (isAbort(e) || signal.aborted) {
        if ((signal.reason as Error | undefined)?.name === 'TimeoutError') {
          log.warn(`request ${reqId} timed out after ${s.generation.timeoutMs}ms`);
          emit({ type: 'error', reqId, error: { code: 'timeout', message: `No answer within ${Math.round(s.generation.timeoutMs / 1000)}s.`, hint: 'Pick a faster model or raise the timeout in settings → Generation.' } });
          result('timeout');
          void this.usage.count('ai_error', { op: 'suggest', category: 'timeout', provider: providerFamily(head) });
        } else {
          log.debug(`request ${reqId} cancelled`);
          result('cancelled');
        }
        return;
      }
      counters.errors++;
      const err = e instanceof LLMError ? e : new LLMError('unknown', (e as Error)?.message ?? String(e));
      log.error(`generation failed [${err.code}]: ${err.message}`, { hint: err.hint, provider: err.provider });
      emit({ type: 'error', reqId, error: err.toInfo() });
      result('error');
      void this.usage.count('ai_error', { op: 'suggest', category: errorCategory(err.code), provider: familyOfLabel(chain, err.provider) });
    }
  }

  /** Fill many fields with one model call. Facts answer the factual fields directly. */
  async fillForm(fields: { id: string; field: FieldContext }[], page: PageContext, signal: AbortSignal) {
    const s = this.settings();
    const t0 = performance.now();
    const facts = await this.facts();
    const values: Record<string, string> = {};
    const sources: Record<string, string> = {};
    const remaining: { id: string; field: FieldContext }[] = [];

    for (const f of fields) {
      if (isSensitive(f.field.semantic)) continue;
      const fm = matchFacts(f.field, facts, 1)[0];
      if (fm && (fm.score ?? 0) >= 0.99 && !f.field.longForm) {
        values[f.id] = fm.text;
        sources[f.id] = 'fact';
      } else remaining.push(f);
    }
    log.info(`fill-form: ${fields.length} fields, ${Object.keys(values).length} from facts, ${remaining.length} to the model`);

    if (remaining.length) {
      const query = remaining.map((r) => r.field.label).join(' ');
      const { chunks } = await this.retrieve(remaining[0].field, query);
      const prompt = this.prepare(buildBatchPrompt(remaining, page, factsBlock(facts), chunks, s));
      const r = await generateWithFallback(s, {
        system: systemPrompt(s),
        prompt,
        schema: BATCH_SCHEMA,
        temperature: Math.min(s.generation.temperature, 0.5),
        maxTokens: Math.max(s.generation.maxOutputTokens, 2048),
        thinking: s.generation.thinking,
        stream: s.generation.streaming,
        signal,
      });
      const parsed = parseBatch(r.text);
      for (const f of remaining) {
        const v = parsed[f.id];
        if (v?.trim()) {
          values[f.id] = clampToLength(v, f.field.maxLength);
          sources[f.id] = 'ai';
        }
      }
      log.info(`fill-form model answered ${Object.keys(parsed).length} fields via ${r.provider.label}`);
    }
    return { values, sources, ms: Math.round(performance.now() - t0) };
  }

  /**
   * Save a user's own / corrected answer to memory:
   *  - always: a verified history entry (exact question → instant, AI skipped next time)
   *  - short answers: a key fact (so the AI also uses it for related questions)
   *  - long answers: a Q&A pair in the "Saved answers" note (retrievable context)
   */
  async learn(field: FieldContext, text: string, host: string, mode: 'smart' | 'history' = 'smart'): Promise<{ savedAs: string[]; label: string }> {
    const answer = text.trim();
    if (!answer || isSensitive(field.semantic)) return { savedAs: [], label: '' };
    const question = (field.label || field.placeholder || field.name || '').trim();
    await recordAccepted(field, answer, host, { verified: true });
    const savedAs = ['answer'];

    if (mode === 'smart' && question) {
      const short = answer.length <= 160 && !answer.includes('\n');
      if (short) {
        const key = field.semantic !== 'text' && !field.chat ? field.semantic : canonicalKey(questionText(field)).slice(0, 80);
        const label = field.semantic !== 'text' && !field.chat ? semanticLabel(field.semantic) : question.slice(0, 120);
        const existing = await db().facts.where('key').equals(key).first();
        if (existing) await db().facts.update(existing.id, { value: answer, label, source: existing.source === 'manual' ? 'manual' : 'learned', updatedAt: Date.now() });
        else await db().facts.put({ id: uid('fact'), key, label, value: answer, source: 'learned', updatedAt: Date.now() });
        savedAs.push('fact');
      } else {
        const id = SAVED_ANSWERS_DOC;
        const s = this.settings();
        const opts = { chunkSize: s.memory.chunkSize, chunkOverlap: s.memory.chunkOverlap };
        const doc = await db().docs.get(id);
        const block = `Q: ${question}\nA: ${answer}`;
        if (!doc) {
          await addDocument({ id, name: 'Saved answers', type: 'note', text: block }, opts);
        } else {
          // Replace an earlier answer to the same question, otherwise append.
          const pairs = doc.text.split(/\n{2,}(?=Q: )/).filter((b) => !b.startsWith(`Q: ${question}\n`));
          await updateDocumentText(id, [...pairs, block].join('\n\n'), opts);
        }
        await db().docs.update(id, { factsStatus: 'skipped' });
        savedAs.push('note');
      }
    }
    await bumpMemoryVersion();
    this.index.invalidate();
    invalidateHistoryCache();
    log.info(`learned answer for "${question}" → ${savedAs.join(' + ')}`);
    return { savedAs, label: question };
  }

  /** LLM-extract key facts from a document and upsert them. */
  async extractFacts(docId: string, signal?: AbortSignal, trigger: 'auto' | 'manual' = 'auto'): Promise<number> {
    const doc = await db().docs.get(docId);
    if (!doc) return 0;
    const s = this.settings();
    const report = (result: string, n = 0) => void this.usage.count('facts_extracted', { result, trigger, facts: countBucket(n) });
    if (!activeProviders(s).length) {
      await db().docs.update(docId, { factsStatus: 'skipped', error: 'No AI provider configured' });
      report('skipped');
      return 0;
    }
    const t0 = performance.now();
    await db().docs.update(docId, { factsStatus: 'pending', error: undefined });
    try {
      const r = await generateWithFallback(s, {
        system: FACTS_SYSTEM,
        prompt: this.prepare(buildFactsPrompt(doc.name, doc.text)),
        schema: FACTS_SCHEMA,
        temperature: 0,
        maxTokens: 2048,
        thinking: 'off',
        stream: false,
        signal: signal ?? AbortSignal.timeout(90_000),
      });
      const found = parseFacts(r.text);
      const existing = await db().facts.toArray();
      const manualKeys = new Set(existing.filter((f) => f.source === 'manual').map((f) => f.key));
      // Replace previously extracted facts from this doc.
      await db().facts.bulkDelete(existing.filter((f) => f.docId === docId && f.source === 'extracted').map((f) => f.id));
      const now = Date.now();
      const rows: Fact[] = [];
      const seen = new Set<string>();
      for (const f of found) {
        const key = canonicalKey(f.label);
        if (manualKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        rows.push({ id: uid('fact'), key, label: semanticLabel(key) !== key ? semanticLabel(key) : f.label, value: f.value, source: 'extracted', docId, updatedAt: now });
      }
      await db().facts.bulkPut(rows);
      await db().docs.update(docId, { factsStatus: 'done' });
      await bumpMemoryVersion();
      log.info(`extracted ${rows.length} facts from ${doc.name}`);
      report(rows.length ? 'ok' : 'empty', rows.length);
      void this.usage.count('ai_latency', { op: 'facts', provider: providerFamily(r.provider), bucket: msBucket(performance.now() - t0) });
      return rows.length;
    } catch (e) {
      log.error(`fact extraction failed for ${doc.name}`, e);
      report('error');
      void this.usage.count('ai_error', { op: 'facts', category: errorCategory((e as LLMError)?.code), provider: familyOfLabel(activeProviders(s), (e as LLMError)?.provider) });
      await db().docs.update(docId, { factsStatus: 'error', error: (e as Error).message });
      return 0;
    }
  }
}

export const SAVED_ANSWERS_DOC = 'doc_saved_answers';

/** The provider family for an error's provider label (labels are the user's own, so never sent). */
export function familyOfLabel(chain: ProviderConfig[], label: string | undefined): string {
  return providerFamily(chain.find((p) => p.label === label) ?? chain[0]);
}

function dedupeDocs(chunks: RetrievedChunk[]): { doc: string; score: number }[] {
  const m = new Map<string, number>();
  for (const c of chunks) m.set(c.docName, Math.max(m.get(c.docName) ?? 0, c.score));
  return [...m.entries()].map(([doc, score]) => ({ doc, score }));
}
