/**
 * Autopilot scheduling, as pure functions (the background runner does the Chrome calls).
 * Times are India time (Asia/Kolkata, UTC+5:30, no daylight saving).
 */
import type { Settings } from './settings';

type AP = Settings['autopilot'];

const IST_MS = 330 * 60_000;

/** India-time clock parts for an instant. */
export function ist(now = new Date()) {
  const d = new Date(now.getTime() + IST_MS);
  return { date: d.toISOString().slice(0, 10), day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

const hm = (s: string, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2])) : fallback;
};

export function inActiveHours(ap: Pick<AP, 'startTime' | 'endTime' | 'days'>, now = new Date()): boolean {
  const t = ist(now);
  return ap.days.includes(t.day) && t.minutes >= hm(ap.startTime, 600) && t.minutes < hm(ap.endTime, 1170);
}

/** The next moment the active hours start (now if they already have). */
export function nextStart(ap: Pick<AP, 'startTime' | 'endTime' | 'days'>, now = new Date()): Date {
  if (inActiveHours(ap, now)) return now;
  const start = hm(ap.startTime, 600);
  for (let add = 0; add < 8; add++) {
    const t = ist(new Date(now.getTime() + add * 86_400_000));
    if (!ap.days.includes(t.day)) continue;
    // Midnight India time of that day, plus the start time.
    const midnight = Date.parse(`${t.date}T00:00:00Z`) - IST_MS;
    const at = new Date(midnight + start * 60_000);
    if (at.getTime() > now.getTime()) return at;
  }
  return new Date(now.getTime() + 86_400_000);
}

export function titlesOf(ap: Pick<AP, 'titles'>): string[] {
  const seen = new Set<string>();
  return ap.titles
    .split(/[\n,]+/)
    .map((t) => t.trim())
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

/** LinkedIn search: Easy Apply only, newest first, posted within the chosen days, in India. */
export function linkedInSearchUrl(title: string, ap: Pick<AP, 'location' | 'postedDays'> & { searchUrl?: string }): string {
  if (ap.searchUrl?.includes('{title}')) return ap.searchUrl.replace('{title}', encodeURIComponent(title));
  const p = new URLSearchParams({
    keywords: title,
    location: 'India',
    geoId: '102713980',
    f_AL: 'true',
    f_TPR: `r${ap.postedDays * 86_400}`,
    sortBy: 'DD',
  });
  if (ap.location === 'india-remote') p.set('f_WT', '2');
  return `https://www.linkedin.com/jobs/search-results/?${p}`;
}

export interface DayState {
  date: string;
  sent: number;
  dry: number;
  skipped: number;
  perTitle: Record<string, number>;
  /** Titles whose search had nothing left today. */
  exhausted: string[];
}

export const freshDay = (date: string): DayState => ({ date, sent: 0, dry: 0, skipped: 0, perTitle: {}, exhausted: [] });

/** Next title to search: round-robin after `last`, skipping titles at their cap or exhausted. */
export function pickTitle(titles: string[], day: DayState, perTitleCap: number, last = -1): { title: string; index: number } | null {
  for (let i = 1; i <= titles.length; i++) {
    const index = (last + i) % titles.length;
    const t = titles[index];
    if ((day.perTitle[t] ?? 0) >= perTitleCap || day.exhausted.includes(t)) continue;
    return { title: t, index };
  }
  return null;
}

/** How many to try in this batch: random in [min, max], within what's left today and for the title. */
export function batchSize(ap: Pick<AP, 'batchMin' | 'batchMax' | 'dailyCap' | 'perTitleCap'>, day: DayState, title: string, rand = Math.random()): number {
  const lo = Math.min(ap.batchMin, ap.batchMax);
  const hi = Math.max(ap.batchMin, ap.batchMax);
  const want = lo + Math.floor(rand * (hi - lo + 1));
  const leftDay = ap.dailyCap - (day.sent + day.dry);
  const leftTitle = ap.perTitleCap - (day.perTitle[title] ?? 0);
  return Math.max(0, Math.min(want, leftDay, leftTitle));
}

/** Minutes until the next batch: random in [min, max]. */
export function gapMinutes(ap: Pick<AP, 'gapMinMin' | 'gapMaxMin'>, rand = Math.random()): number {
  const lo = Math.min(ap.gapMinMin, ap.gapMaxMin);
  const hi = Math.max(ap.gapMinMin, ap.gapMaxMin);
  return lo + rand * (hi - lo);
}
