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
