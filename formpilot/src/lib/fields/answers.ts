/** Answers decided by rule, without the AI. Pure functions (used in the background). */
import type { FieldContext } from '../types';
import { parseDurationDays, rangeOption } from './adapt';
import { bestOption, exactOption, splitChoices } from './fill';

/** A stored answer fits a choice question only when it names one of the options. */
export function answerFitsOptions(answer: string, f: Pick<FieldContext, 'options' | 'inputType' | 'label'>): boolean {
  const opts = f.options ?? [];
  if (!opts.length) return true;
  const o = opts.map((x) => ({ value: x.value, label: x.label || x.value }));
  const parts = f.inputType === 'checkbox' ? splitChoices(answer, o.map((x) => x.label)) : [answer];
  return parts.length > 0 && parts.every((p) => !!exactOption(p, o) || rangeOption(p, o.map((x) => x.label), f.label) >= 0 || !!bestOption(p, o));
}

const START_Q = /\b(earliest|soonest)\b.*\b(start|join|begin)|\b(start|joining|join|availability|available)\s*(date|from|on)\b|\bwhen can you (start|join)\b|\bdate (of|you can) (join|start)/i;

/** "What is your earliest start date?" in a date/text box → today + notice period (ISO; the fill adapts the format). */
export function startDateAnswer(f: Pick<FieldContext, 'label' | 'kind' | 'inputType' | 'options'>, notice?: string, now = new Date()): string | null {
  if (!START_Q.test(f.label ?? '') || f.options?.length || f.kind === 'textarea' || f.kind === 'select') return null;
  if (!['date', 'text', 'search', ''].includes(f.inputType ?? '')) return null;
  const days = (notice ? parseDurationDays(notice) : null) ?? 30;
  const d = new Date(now.getTime() + Math.max(0, days) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** "How many years of (work) experience do you have with Flutter / in Sales / overall?" */
export const YEARS_Q = /\b(how many|number of|total)\b[^?]*\byears?\b|\byears? of (work |professional |relevant |hands-on )?experience\b|\bexperience\b[^?]*\(in years\)/i;

/** Experience you didn't state: 3 years (your rule), never 0 or blank. */
export const DEFAULT_YEARS = 3;

/**
 * Fix an experience answer: blank, 0, "none", "N/A" or "less than a year" becomes 3 years.
 * Numbers the AI took from your resume (1+) stay as they are.
 */
export function experienceAnswer(f: Pick<FieldContext, 'label' | 'options' | 'kind'>, answer: string | undefined): string | null {
  if (!YEARS_Q.test(f.label ?? '')) return null;
  const a = (answer ?? '').trim();
  const n = parseFloat(a.replace(/,/g, ''));
  const weak = !a || /^(0+(\.0+)?|none|no|nil|n\/?a|not applicable|-|less than (a|1) year|fresher)\b/i.test(a) || (Number.isFinite(n) && n < 1);
  if (!weak) return null;
  return f.options?.length ? `${DEFAULT_YEARS} years` : String(DEFAULT_YEARS);
}

/**
 * Questions that only screen you out when answered "No": commuting, relocating, on-site or
 * hybrid work, shifts, weekends, background checks, joining on time. Answered Yes by rule.
 * (Not for facts about you, like where you live now or your visa: those come from memory.)
 */
const KEEP_IN = /\b(comfortable|willing|open|okay|ok|able|ready|happy|agree|available)\b[^?]*\b(commut|relocat|on-?site|onsite|in[- ]office|office|hybrid|work from (the )?office|wfo|travel|shifts?|night|weekends?|rotational|join (immediately|within|in)|background (check|verification)|bond|contract|probation|notice period buy ?out)/i;

export function keepInAnswer(f: Pick<FieldContext, 'label' | 'options'>): string | null {
  if (!KEEP_IN.test(f.label ?? '')) return null;
  const opts = f.options ?? [];
  if (!opts.length) return 'Yes';
  const yes = opts.find((o) => /^\s*yes\b/i.test(o.label || o.value));
  return yes ? yes.label || yes.value : null;
}
