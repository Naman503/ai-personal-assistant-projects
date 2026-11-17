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

export function inActiveHours(ap: Pick<AP, 'startTime' | 'endTime' | 'days'> & { useHours?: boolean }, now = new Date()): boolean {
  if (ap.useHours === false) return true;
  const t = ist(now);
  return ap.days.includes(t.day) && t.minutes >= hm(ap.startTime, 600) && t.minutes < hm(ap.endTime, 1170);
}

/** The next moment the active hours start (now if they already have). */
export function nextStart(ap: Pick<AP, 'startTime' | 'endTime' | 'days'> & { useHours?: boolean }, now = new Date()): Date {
  // No hours: after a full day, the next start is just after midnight India time (new limits).
  if (ap.useHours === false) {
    const t = ist(now);
    return new Date(Date.parse(`${t.date}T00:00:00Z`) - IST_MS + 86_400_000 + 5 * 60_000);
  }
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
  /** Titles whose search had nothing left today ("naukri:Mobile Engineer" for other sites). */
  exhausted: string[];
  /** Per platform: sent / would apply / skipped. */
  byPlatform: Record<'linkedin' | 'naukri' | 'foundit' | 'cutshort', { sent: number; dry: number; skipped: number }>;
  /** Naukri / Cutshort job pages already tried today. */
  seen: string[];
  /** Titles whose last-N-days search ran out today: searched over the past week from then on. */
  widened?: string[];
  /** When Naukri's Recommended list last had nothing that fits (it refreshes during the day). */
  recEmptyAt?: number;
  /** Portals stopped for the rest of today (their daily limit, a sign-in or security wall). */
  blocked?: Partial<Record<'linkedin' | 'naukri' | 'foundit' | 'cutshort', { reason: string; at: number; kind: 'limit' | 'security' }>>;
}

const zero = () => ({ sent: 0, dry: 0, skipped: 0 });
export const freshDay = (date: string): DayState => ({ date, sent: 0, dry: 0, skipped: 0, perTitle: {}, exhausted: [], byPlatform: { linkedin: zero(), naukri: zero(), foundit: zero(), cutshort: zero() }, seen: [] });

/** A stored day from an older version: fill in what it lacks. */
export function normalizeDay(d: Partial<DayState> & { date: string }): DayState {
  const f = freshDay(d.date);
  const day = { ...f, ...d, byPlatform: { ...f.byPlatform, ...(d.byPlatform ?? {}) } } as DayState;
  if (!d.byPlatform) day.byPlatform.linkedin = { sent: d.sent ?? 0, dry: d.dry ?? 0, skipped: d.skipped ?? 0 };
  return day;
}

/** Per-title counter key: LinkedIn keeps the plain title (older days), other sites are prefixed. */
export const titleKey = (platform: string, title: string) => (platform === 'linkedin' ? title : `${platform}:${title}`);

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

/** Next midnight in California (when Gemini's free daily quota resets), as an instant. */
export function nextPacificMidnight(now = new Date()): Date {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const laAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  const offset = laAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day + 1, 0, 0, 0) - offset);
}

/** AI errors that mean "wait" (or "fix the settings"), not "this job can't be done". */
export const AI_BLOCKING = new Set(['rate-limit', 'quota', 'auth', 'no-provider', 'locked', 'unavailable']);
