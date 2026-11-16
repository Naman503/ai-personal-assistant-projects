/**
 * Employment / education dates in "Month ▾  Year ▾" dropdowns (LinkedIn's Edit experience step,
 * many ATS forms). The boxes have no labels of their own ("Month", "Year" under "From" / "To"),
 * so the AI can't tell what they're for. They're filled by rule instead, with no AI request:
 *
 *  - the company comes from the same block's Company / School field,
 *  - the years come from the resume ("Metafic · 2023 – 2025", "Eazeebox · 2025 – Present"),
 *  - the months come from what you picked before for that company (remembered here), or the
 *    resume when it has them ("Jun 2023 – Mar 2025"). Never guessed: a missing month is left
 *    for you, and remembered once you pick it.
 */
import { isVisible, resolveLabel, type FillableElement } from './context';

export interface YM {
  y: number;
  m?: number; // 1-12
}
export interface WorkSpan {
  /** The lines around the dates: company, title, school… used to match a company name. */
  context: string;
  from: YM;
  to: YM | 'present';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = String.raw`(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+|(\d{1,2})[/\-.])?`;
const RANGE = new RegExp(String.raw`${MON}((?:19|20)\d{2})\s*(?:–|—|-|to|until)\s*(?:${MON}((?:19|20)\d{2})|(present|current|now|till date|today|ongoing))`, 'i');

const ym = (mon: string | undefined, num: string | undefined, y: string): YM => {
  const m = mon ? MONTHS.indexOf(mon.slice(0, 3).toLowerCase()) + 1 : num ? Number(num) : undefined;
  return { y: Number(y), m: m && m >= 1 && m <= 12 ? m : undefined };
};

/** Every date range in a resume, with the few lines before it (where the company and title sit). */
export function parseWorkHistory(text: string): WorkSpan[] {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out: WorkSpan[] = [];
  lines.forEach((line, i) => {
    const r = line.match(RANGE);
    if (!r) return;
    const from = ym(r[1], r[2], r[3]);
    const to = r[7] ? 'present' : ym(r[4], r[5], r[6]);
    const before = line.slice(0, r.index).trim();
    const context = [lines[i - 2] ?? '', lines[i - 1] ?? '', before].filter((l) => l && !/^[•\-*]/.test(l)).join(' · ');
    out.push({ context, from, to });
  });
  return out;
}

/** "Softnotions Technologies Pvt Ltd" → "softnotions", for loose company matching. */
const SUFFIX = /\b(pvt|private|ltd|limited|inc|llp|llc|corp|corporation|co|company|technologies|technology|tech|solutions|services|software|india|group|labs?|the)\b/g;
export const orgKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();

/** The resume span for this company (the most recent one if it appears twice). */
export function spanFor(company: string, spans: WorkSpan[]): WorkSpan | null {
  const k = orgKey(company);
  if (!k) return null;
  const first = k.split(' ')[0];
  const hits = spans.filter((s) => {
    const c = orgKey(s.context);
    return c.includes(k) || (first.length > 3 && c.split(' ').includes(first));
  });
  return hits.sort((a, b) => b.from.y - a.from.y)[0] ?? null;
}

// ---------------------------------------------------------------- the dropdowns

export interface DateGroup {
  month: HTMLSelectElement | null;
  year: HTMLSelectElement;
  role: 'from' | 'to';
}
export interface DateBlock {
  company: string;
  companyField: HTMLElement | null;
  current: HTMLInputElement | null;
  groups: DateGroup[];
}

const isMonthSelect = (s: HTMLSelectElement) => [...s.options].filter((o) => MONTHS.includes(o.text.trim().slice(0, 3).toLowerCase())).length >= 12;
const isYearSelect = (s: HTMLSelectElement) => [...s.options].filter((o) => /^(19|20)\d{2}$/.test(o.text.trim())).length >= 5;

/** Text of an element without the option lists of the dropdowns inside it. */
function ownText(el: Element): string {
  let t = '';
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('select') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  while (walk.nextNode()) t += ` ${walk.currentNode.textContent}`;
  return t.replace(/\s+/g, ' ').trim();
}

function roleOf(year: HTMLSelectElement): 'from' | 'to' | null {
  let p = year.parentElement;
  for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
    const t = ownText(p).toLowerCase();
    const from = /\b(from|start(ed)?|start date|joined)\b/.test(t);
    const to = /\b(to|end(ed)?|end date|until|till|left)\b/.test(t);
    if (from !== to) return from ? 'from' : 'to';
    if (from && to) return null;
  }
  return null;
}

const fieldLabel = (el: Element) => (resolveLabel(el as FillableElement) || el.getAttribute('aria-label') || '').toLowerCase();

/** Date dropdown pairs inside `scope`, grouped by the experience/education block they belong to. */
export function dateBlocks(scope: ParentNode): DateBlock[] {
  const years = [...scope.querySelectorAll<HTMLSelectElement>('select')].filter((s) => isYearSelect(s) && isVisible(s));
  const blocks = new Map<Element, DateBlock>();
  for (const year of years) {
    const role = roleOf(year);
    if (!role) continue;
    // The month dropdown next to it: the nearest ancestor holding exactly one of each.
    let month: HTMLSelectElement | null = null;
    let p = year.parentElement;
    for (let i = 0; i < 4 && p && !month; i++, p = p.parentElement) {
      const ms = [...p.querySelectorAll<HTMLSelectElement>('select')].filter(isMonthSelect);
      const ys = [...p.querySelectorAll<HTMLSelectElement>('select')].filter(isYearSelect);
      if (ys.length > 1) break;
      if (ms.length === 1) month = ms[0];
    }
    // The block: the nearest ancestor with a Company / School / Organisation field.
    let block: Element | null = year.parentElement;
    let companyField: HTMLElement | null = null;
    for (let i = 0; i < 10 && block; i++) {
      companyField = [...block.querySelectorAll<HTMLElement>('input[type=text], input:not([type])')].find((x) => /\b(company|employer|organi[sz]ation|school|college|university|institut)/.test(fieldLabel(x))) ?? null;
      if (companyField) break;
      if (block === scope) break;
      block = block.parentElement;
    }
    if (!block || !companyField) continue;
    let b = blocks.get(block);
    if (!b) {
      const current = [...block.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find((c) => /currently (work|study|attend)|current (job|role|position)|still (work|here)|present/i.test(fieldLabel(c) || c.closest('label')?.textContent || '')) ?? null;
      b = { company: (companyField as HTMLInputElement).value.trim(), companyField, current, groups: [] };
      blocks.set(block, b);
    }
    b.groups.push({ month, year, role });
  }
  return [...blocks.values()];
}

// ---------------------------------------------------------------- remembered months

export const WORK_KEY = 'fpWorkHistory';
export type Remembered = Record<string, { from?: YM | 'present'; to?: YM | 'present' }>;

/** What to put in one block: per role, the year and (if known) the month. */
export function plan(block: DateBlock, spans: WorkSpan[], remembered: Remembered) {
  const mem = remembered[orgKey(block.company)] ?? {};
  const span = spanFor(block.company, spans);
  const pick = (role: 'from' | 'to'): YM | 'present' | null => {
    const r = mem[role];
    const s = span?.[role] ?? null;
    if (r === 'present' || (!r && s === 'present')) return 'present';
    if (r) return { y: r.y, m: r.m ?? (s && s !== 'present' && s.y === r.y ? s.m : undefined) };
    return s && s !== 'present' ? { y: s.y, m: s.m } : null;
  };
  return { from: pick('from'), to: pick('to'), matched: !!span || !!remembered[orgKey(block.company)] };
}
