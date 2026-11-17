/**
 * How each model does for each pilot: AI calls (fields asked and answered, time, failures,
 * fallbacks from the cloud model to the local one) and what the applications came to (sent,
 * ready, left for you, skipped). Kept in chrome.storage.local, shown on the pilots' pages.
 */
import type { Pilot } from './llm/pilot-ai';

export const AI_STATS_KEY = 'fpAiStats';

export interface ModelStats {
  calls: number;
  failed: number;
  asked: number;
  answered: number;
  ms: number;
  /** Calls the local model took over because the cloud one couldn't answer. */
  fallbacks: number;
  outcomes: Record<string, number>;
  last: number;
}

export interface AiStats {
  since: number;
  pilots: Partial<Record<Pilot, Record<string, ModelStats>>>;
}

const blank = (): ModelStats => ({ calls: 0, failed: 0, asked: 0, answered: 0, ms: 0, fallbacks: 0, outcomes: {}, last: 0 });

export async function loadAiStats(): Promise<AiStats> {
  const got = (await chrome.storage.local.get(AI_STATS_KEY))[AI_STATS_KEY] as AiStats | undefined;
  return got ?? { since: Date.now(), pilots: {} };
}

let queue: Promise<unknown> = Promise.resolve();
/** Changes run one after another (several tabs answer at once). */
function update(fn: (s: AiStats) => void): Promise<void> {
  const run = queue.then(async () => {
    const s = await loadAiStats();
    fn(s);
    await chrome.storage.local.set({ [AI_STATS_KEY]: s });
  });
  queue = run.catch(() => {});
  return run;
}

function slot(s: AiStats, who: Pilot, model: string): ModelStats {
  const p = (s.pilots[who] ??= {});
  return (p[model || 'no AI needed'] ??= blank());
}

export function recordAiCall(who: Pilot, model: string, r: { ms: number; asked: number; answered: number; failed?: boolean; fallback?: boolean }) {
  return update((s) => {
    const m = slot(s, who, model);
    m.calls++;
    if (r.failed) m.failed++;
    if (r.fallback) m.fallbacks++;
    m.asked += r.asked;
    m.answered += r.answered;
    m.ms += r.ms;
    m.last = Date.now();
  });
}

export function recordOutcome(who: Pilot, model: string, outcome: string, n = 1) {
  if (!n) return Promise.resolve();
  return update((s) => {
    const m = slot(s, who, model);
    m.outcomes[outcome] = (m.outcomes[outcome] ?? 0) + n;
    m.last = Date.now();
  });
}

export function resetAiStats() {
  return update((s) => {
    s.since = Date.now();
    s.pilots = {};
  });
}

/** One row per model, with rates, for the report. */
export function reportRows(stats: AiStats, who: Pilot) {
  return Object.entries(stats.pilots[who] ?? {})
    .map(([model, m]) => {
      const done = Object.values(m.outcomes).reduce((a, b) => a + b, 0);
      const good = (m.outcomes.sent ?? 0) + (m.outcomes.ready ?? 0) + (m.outcomes.dry ?? 0);
      return {
        model,
        calls: m.calls,
        answerRate: m.asked ? m.answered / m.asked : null,
        avgSec: m.calls ? m.ms / m.calls / 1000 : null,
        failRate: m.calls ? m.failed / m.calls : null,
        fallbacks: m.fallbacks,
        outcomes: m.outcomes,
        completion: done ? good / done : null,
        last: m.last,
      };
    })
    .sort((a, b) => b.calls - a.calls);
}
