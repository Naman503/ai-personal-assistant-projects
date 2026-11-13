/**
 * Fit one answer to what a particular field accepts.
 *
 * The same fact is asked for in many shapes: "Notice period" (30 days), "Notice period in days"
 * (30, digits only), "Notice period (months)" (1), "Current CTC" (10,75,000), "Current CTC in lacs"
 * (10.75), "Monthly salary" (89583), "Experience in months" (42), "LWD (ddmmyy)" (151226)…
 * FormPilot stores the answer once, the way you wrote it, and converts it here at insert time,
 * using the field's type, inputmode, pattern, maxlength, placeholder and the question's wording.
 * Dropdowns and radio groups get range matching: 30 days picks "1 month", 3+ years picks "3-5 years".
 *
 * Rule of thumb: convert only when the field clearly asks for a different shape. A free-text
 * field with no unit hint gets the answer exactly as written.
 */

import { normalizeText } from '../util';

export interface FieldSpec {
  /** Question text: label, placeholder, aria-label (lowercased, normalised). */
  q: string;
  /** Raw placeholder (formats like "DD/MM/YYYY" live there). */
  placeholder: string;
  type: string;
  inputMode: string;
  pattern: string;
  maxLength: number;
  step: string;
}

export function specOf(el: Element, label = ''): FieldSpec {
  const input = el as HTMLInputElement;
  const placeholder = el.getAttribute('placeholder') ?? '';
  return {
    q: normalizeText(`${label} ${placeholder} ${el.getAttribute('aria-label') ?? ''}`),
    placeholder,
    type: (el instanceof HTMLInputElement ? input.type : el.tagName === 'TEXTAREA' ? 'textarea' : '').toLowerCase(),
    inputMode: (el.getAttribute('inputmode') ?? '').toLowerCase(),
    pattern: el.getAttribute('pattern') ?? '',
    maxLength: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.maxLength : -1,
    step: el.getAttribute('step') ?? '',
  };
}

// ---------------------------------------------------------------- what the field wants

const has = (s: string, re: RegExp) => re.test(s);

/** Only digits (and maybe a decimal point) are accepted. */
export function wantsNumberOnly(f: FieldSpec): boolean {
  if (f.type === 'number' || f.type === 'range') return true;
  if (f.inputMode === 'numeric' || f.inputMode === 'decimal') return true;
  // pattern made only of digit classes, quantifiers and an optional decimal point
  if (f.pattern && /^\^?(\[(0-9|\\d)(\.|\\\.)?\]|\\d)[*+{}\d,]*((\\?\.|\(\\\.\\d[*+{}\d,]*\)\??)[\\d\[\]0-9*+{}?,]*)?\$?$/.test(f.pattern)) return true;
  return has(f.q, /\b(numbers? only|only numbers?|numeric( value)?( only)?|digits only|only digits|in numbers|in digits|without (any )?(text|words|units))\b/);
}

function decimalsAllowed(f: FieldSpec): boolean {
  if (f.inputMode === 'numeric') return false;
  if (f.type === 'number') return f.step === 'any' || /\./.test(f.step);
  if (f.pattern) return /\\\.|\[[^\]]*\.[^\]]*\]/.test(f.pattern);
  return true;
}

type MoneyUnit = 1 | 1e3 | 1e5 | 1e7;
function moneyUnitAsked(q: string): MoneyUnit | null {
  if (/\b(lpa|lakhs?|lacs?|lac|lakh|in l)\b/.test(q)) return 1e5;
  if (/\b(crores?|cr)\b/.test(q)) return 1e7;
  if (/\b(thousands?|in k|000s)\b/.test(q)) return 1e3;
  if (/\b(in (inr|rupees|rs)|absolute|full amount|exact amount)\b/.test(q)) return 1;
  return null;
}
const isMoneyQ = (q: string) => /\b(ctc|salary|compensation|package|stipend|remuneration|income|pay|lpa|earning|take home|in hand)\b/.test(q);
function periodAsked(q: string): 'month' | 'year' | null {
  if (/\b(per month|monthly|a month|pm|p m|in hand per month|month wise)\b/.test(q)) return 'month';
  if (/\b(per annum|annual|annually|per year|yearly|pa|p a|lpa|ctc)\b/.test(q)) return 'year';
  return null;
}
const isDurationQ = (q: string) => /\b(notice|join|joining|how soon|availability|available to start|start date in|serve|serving)\b/.test(q) && !/\b(date|lwd|last working day)\b/.test(q);
const isExperienceQ = (q: string) => /\b(experience|exp|years? (of|in|with|working))\b/.test(q);
function durationUnitAsked(q: string): 'days' | 'weeks' | 'months' | 'years' | null {
  if (/\b(in )?days?\b/.test(q)) return 'days';
  if (/\b(in )?weeks?\b/.test(q)) return 'weeks';
  if (/\b(in )?months?\b/.test(q)) return 'months';
  if (/\b(in )?years?\b/.test(q)) return 'years';
  return null;
}

// ---------------------------------------------------------------- reading an answer

const NUM = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const toNum = (s: string) => Number(s.replace(/,/g, ''));

/** A money amount in rupees, and whether the text says it's monthly or yearly. */
export function parseMoney(text: string): { inr: number; period: 'month' | 'year' | null } | null {
  const t = text.toLowerCase();
  const m = t.match(new RegExp(`${NUM}\\s*(lpa|lakhs?|lacs?|lac|l\\b|crores?|cr\\b|k\\b|thousand)?`));
  if (!m) return null;
  let n = toNum(m[1]);
  const unit = m[2] ?? '';
  if (/^(lpa|lakh|lac|l)/.test(unit)) n *= 1e5;
  else if (/^(crore|cr)/.test(unit)) n *= 1e7;
  else if (/^(k|thousand)/.test(unit)) n *= 1e3;
  else if (n < 200 && /\b(lpa|lakhs?|lacs?)\b/.test(t)) n *= 1e5; // "10.75 (in lakhs)"
  const period = /\b(per month|monthly|\/ ?month|pm|p\.m\.|a month)\b/.test(t) ? 'month' : /\b(per annum|annual|p\.a\.|pa|lpa|per year|yearly|ctc)\b/.test(t) ? 'year' : null;
  return { inr: n, period };
}

/** A duration in days ("30 days", "1 month", "2 weeks", "Immediate"). */
export function parseDurationDays(text: string): number | null {
  const t = text.toLowerCase();
  if (/\b(immediate(ly)?|right away|asap|now|0 days?)\b/.test(t)) return 0;
  const m = t.match(/(\d+(?:\.\d+)?)\s*(days?|d\b|weeks?|wks?|months?|mos?|mnths?|years?|yrs?)/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2];
  if (/^(w)/.test(u)) return n * 7;
  if (/^(mo|mn)/.test(u)) return n * 30;
  if (/^(y)/.test(u)) return n * 365;
  return n;
}

/** Experience in years ("3+ years", "3 years 6 months", "42 months", "3.5"). */
export function parseYears(text: string): number | null {
  const t = text.toLowerCase();
  const y = t.match(/(\d+(?:\.\d+)?)\s*\+?\s*(years?|yrs?|y\b)/);
  const mo = t.match(/(\d+)\s*(months?|mos?|mnths?)/);
  if (y) return Number(y[1]) + (mo ? Number(mo[1]) / 12 : 0);
  if (mo) return Number(mo[1]) / 12;
  const bare = t.match(/^\s*(\d+(?:\.\d+)?)\s*\+?\s*$/);
  return bare ? Number(bare[1]) : null;
}

const round = (n: number, decimals: boolean) => {
  if (!decimals) return String(Math.round(n));
  return String(Math.round(n * 100) / 100);
};

// ---------------------------------------------------------------- dates

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Read a date the way people in India write it (day first), plus ISO and "15 Dec 2026". */
export function parseDate(text: string): Date | null {
  const t = text.trim();
  let m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = t.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/);
  if (m) return mk(year(+m[3]), +m[2], +m[1]);
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})\.?,?\s+(\d{2,4})\b/i);
  if (m && MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) >= 0) return mk(year(+m[3]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]);
  m = t.match(/\b([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b/i);
  if (m && MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) >= 0) return mk(year(+m[3]), MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
  m = t.match(/^(\d{2})(\d{2})(\d{2}|\d{4})$/); // ddmmyy / ddmmyyyy
  if (m) return mk(year(+m[3]), +m[2], +m[1]);
  return null;
  function year(y: number) {
    return y < 100 ? 2000 + y : y;
  }
  function mk(y: number, mo: number, d: number) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return new Date(Date.UTC(y, mo - 1, d));
  }
}

/** The date format a field asks for ("DD/MM/YYYY", "ddmmyy", "MM-YYYY"), or null. */
export function dateFormatAsked(f: FieldSpec): string | null {
  const src = `${f.placeholder} ${f.q}`;
  const m = src.match(/\b((?:dd|mm|yyyy|yy)(?:[/.\- ]?(?:dd|mm|mmm|yyyy|yy)){1,2})\b/i);
  return m ? m[1] : null;
}

export function formatDate(d: Date, fmt: string): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getUTCFullYear());
  return fmt.replace(/yyyy|yy|mmm|mm|dd/gi, (tok) => {
    const k = tok.toLowerCase();
    if (k === 'yyyy') return yyyy;
    if (k === 'yy') return yyyy.slice(2);
    if (k === 'mmm') return MONTHS[d.getUTCMonth()].replace(/^./, (c) => c.toUpperCase());
    if (k === 'mm') return mm;
    return dd;
  });
}

// ---------------------------------------------------------------- the adapter

/** Convert `text` to the shape this field expects. Returns the text unchanged when unsure. */
export function adaptValue(text: string, f: FieldSpec): string {
  const s = text.trim();
  if (!s || f.type === 'textarea') return s;
  const numOnly = wantsNumberOnly(f);
  const dec = decimalsAllowed(f);
  const q = f.q;

  // Dates: <input type=date> wants ISO; a format in the label/placeholder wins otherwise.
  if (f.type === 'date' || f.type === 'month' || dateFormatAsked(f) || /\b(lwd|last working day|date of|dob)\b/.test(q)) {
    const d = parseDate(s);
    if (d) {
      if (f.type === 'date') return formatDate(d, 'yyyy-mm-dd');
      if (f.type === 'month') return formatDate(d, 'yyyy-mm');
      const fmt = dateFormatAsked(f);
      if (fmt) return formatDate(d, fmt);
    }
  }

  // Phone numbers: digits only / 10-digit fields want the national number.
  if (f.type === 'tel' || /\b(phone|mobile|contact (no|number)|whatsapp)\b/.test(q)) {
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 10 && (numOnly || f.maxLength === 10 || /\b10 digits?\b/.test(q) || /\\d\{10\}|\[0-9\]\{10\}/.test(f.pattern))) return digits.slice(-10);
    return s;
  }

  // Money.
  if (isMoneyQ(q)) {
    const money = parseMoney(s);
    const unit = moneyUnitAsked(q);
    if (money && (numOnly || unit !== null || periodAsked(q) === 'month')) {
      let inr = money.inr;
      const want = periodAsked(q);
      const have = money.period ?? (/\b(ctc|lpa|package)\b/.test(s.toLowerCase()) ? 'year' : null);
      if (want === 'month' && have === 'year') inr /= 12;
      else if (want === 'year' && have === 'month') inr *= 12;
      const u = unit ?? 1;
      return round(inr / u, dec && u !== 1);
    }
  }

  // Notice period / joining time.
  if (isDurationQ(q)) {
    const days = parseDurationDays(s);
    const unit = durationUnitAsked(q) ?? (numOnly ? 'days' : null);
    if (days !== null && unit) {
      const n = unit === 'days' ? days : unit === 'weeks' ? days / 7 : unit === 'months' ? days / 30 : days / 365;
      return round(n, dec && unit !== 'days');
    }
  }

  // Years of experience.
  if (isExperienceQ(q)) {
    const years = parseYears(s);
    const unit = /\b(in months|months)\b/.test(q) && !/\byears?\b/.test(q) ? 'months' : numOnly || /\b(in years|no of years|number of years)\b/.test(q) ? 'years' : null;
    if (years !== null && unit) return unit === 'months' ? String(Math.round(years * 12)) : round(years, dec);
  }

  // Percentages / scores.
  if (numOnly && /%/.test(s)) return s.match(/\d+(?:\.\d+)?/)?.[0] ?? s;

  // Anything else in a numbers-only field: the first number, without separators.
  if (numOnly) {
    const m = s.replace(/(\d),(?=\d)/g, '$1').match(/-?\d+(?:\.\d+)?/);
    if (!m) return '';
    return dec ? m[0] : String(Math.round(Number(m[0])));
  }
  return s;
}

// ---------------------------------------------------------------- dropdown / radio ranges

interface Range {
  lo: number;
  hi: number;
}

/** Read "15 days or less", "1-2 months", "5+ years", "0-5 Lakhs", "Immediate" as a numeric range. */
export function optionRange(label: string, kind: 'days' | 'years' | 'inr'): Range | null {
  const t = label.toLowerCase().replace(/(\d),(?=\d)/g, '$1');
  if (kind === 'days' && /\b(immediate(ly)?|already serving|serving notice|currently serving|0 days)\b/.test(t)) return { lo: 0, hi: 0 };
  const unitMul = (u: string | undefined): number => {
    if (!u) return 1;
    if (kind === 'days') return /^w/.test(u) ? 7 : /^m/.test(u) ? 30 : /^y/.test(u) ? 365 : 1;
    if (kind === 'years') return /^m/.test(u) ? 1 / 12 : 1;
    return /^(l|lpa)/.test(u) ? 1e5 : /^(cr)/.test(u) ? 1e7 : /^k/.test(u) ? 1e3 : 1;
  };
  const U = String.raw`(days?|weeks?|months?|years?|yrs?|lpa|lakhs?|lacs?|l\b|crores?|cr\b|k\b)?`;
  const m = t.match(new RegExp(String.raw`(\d+(?:\.\d+)?)\s*${U}\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*${U}`));
  if (m) {
    const u = m[4] ?? m[2];
    return { lo: Number(m[1]) * unitMul(m[2] ?? u), hi: Number(m[3]) * unitMul(u) };
  }
  const one = t.match(new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(\+)?\s*${U}`));
  if (!one) return null;
  const n = Number(one[1]) * unitMul(one[3]);
  if (one[2] || /\b(more than|above|over|greater|or more|and above|plus)\b/.test(t)) return { lo: /\bmore than|above|over|greater\b/.test(t) ? n + 1e-9 : n, hi: Infinity };
  if (/\b(less than|below|under|up ?to|or less|within|max(imum)?)\b/.test(t)) return { lo: 0, hi: /\bless than|below|under\b/.test(t) ? n - 1e-9 : n };
  return { lo: n, hi: n };
}

/**
 * For number-like answers, pick the option whose range contains the value.
 * Returns the index of the option, or -1 when this doesn't apply.
 */
export function rangeOption(answer: string, labels: string[], question = ''): number {
  const q = normalizeText(question);
  const kinds: ('days' | 'years' | 'inr')[] = isMoneyQ(q) ? ['inr'] : isExperienceQ(q) ? ['years'] : isDurationQ(q) ? ['days'] : ['days', 'years', 'inr'];
  for (const kind of kinds) {
    const v = kind === 'days' ? parseDurationDays(answer) : kind === 'years' ? parseYears(answer) : parseMoney(answer)?.inr ?? null;
    if (v === null) continue;
    const ranges = labels.map((l) => optionRange(l, kind));
    if (ranges.filter(Boolean).length < 2) continue;
    // Narrowest range that contains the value; on a boundary ("3" between "1-3" and "3-5")
    // the range that starts there wins, since "3 years" usually means "at least 3".
    let best = -1;
    let bestKey = Infinity;
    ranges.forEach((r, i) => {
      if (!r || v < r.lo || v > r.hi) return;
      const key = r.hi - r.lo + (v === r.hi && r.hi !== r.lo ? 0.5 : 0);
      if (key < bestKey) {
        best = i;
        bestKey = key;
      }
    });
    if (best >= 0) return best;
  }
  return -1;
}

/** A short instruction for the AI prompt so generated answers already have the right shape. */
export function describeExpectation(f: FieldSpec): string {
  const out: string[] = [];
  if (wantsNumberOnly(f)) out.push(decimalsAllowed(f) ? 'answer with a number only (decimals allowed)' : 'answer with a whole number only, no text or units');
  const q = f.q;
  if (isMoneyQ(q)) {
    const u = moneyUnitAsked(q);
    if (u) out.push(`amount in ${u === 1e5 ? 'lakhs' : u === 1e7 ? 'crores' : u === 1e3 ? 'thousands' : 'rupees'}`);
    const p = periodAsked(q);
    if (p) out.push(p === 'month' ? 'per month' : 'per year');
  }
  if (isDurationQ(q)) {
    const u = durationUnitAsked(q);
    if (u) out.push(`in ${u}`);
  }
  const fmt = dateFormatAsked(f);
  if (fmt) out.push(`date as ${fmt}`);
  return out.join(', ');
}
