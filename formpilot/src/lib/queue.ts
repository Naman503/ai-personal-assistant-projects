/**
 * The apply queue's page reading: job cards on a LinkedIn job list, which ones to open, and
 * the bits of the job pane and Easy Apply dialog the queue needs. Pure DOM reading.
 *
 * Built against LinkedIn's /jobs/search-results/ page as of Nov 2026: class names are
 * generated, so everything keys off roles, aria-labels and test ids.
 */
import { CONFIRMATION_RE } from '@/lib/job';
import { isVisible, openDialogs } from '@/lib/fields/context';

export interface JobCard {
  el: HTMLElement;
  title: string;
  company: string;
  applied: boolean;
  easyApply: boolean;
}

const DISMISS = 'button[aria-label^="Dismiss "][aria-label$=" job"]';
/** The card's text lines: rendered lines plus the text of each innermost element (the same, where innerText isn't laid out). */
const lines = (el: HTMLElement) => {
  const rendered = (el.innerText || '').split('\n');
  const leaves = [...el.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => e.textContent || '');
  return [...rendered, ...leaves].map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
};

/** Job cards in the list on the left, top to bottom. */
export function jobCards(doc: Document = document): JobCard[] {
  const out: JobCard[] = [];
  for (const btn of doc.querySelectorAll<HTMLElement>(DISMISS)) {
    // The clickable card: the nearest [role=button] that holds this one Dismiss button.
    let card = btn.parentElement;
    while (card && !(card.getAttribute('role') === 'button' && card.querySelectorAll(DISMISS).length === 1)) card = card.parentElement;
    if (!card || card.querySelectorAll(DISMISS).length !== 1) continue;
    const title = (btn.getAttribute('aria-label') || '').replace(/^Dismiss /, '').replace(/ job$/, '').trim();
    const ls = lines(card);
    // Lines go: title (Verified job), title, company, location, …, Applied?, ·, Easy Apply
    const ti = ls.findIndex((l, i) => i > 0 && l === title && ls[i - 1] !== title);
    const company = ti >= 0 ? (ls[ti + 1] ?? '') : (ls[2] ?? '');
    out.push({ el: card, title, company, applied: ls.includes('Applied'), easyApply: ls.includes('Easy Apply') });
  }
  return out;
}

/** "Engineering Manager, Director" → true for titles containing any of them. */
export function titleSkipped(title: string, skip: string): boolean {
  const t = title.toLowerCase();
  return skip
    .split(/[,\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((s) => t.includes(s));
}

/** Cards worth opening: Easy Apply, not applied, not skipped by title, not already tried. */
export function candidates(cards: JobCard[], skipTitles: string, tried: Set<string>): JobCard[] {
  return cards.filter((c) => c.easyApply && !c.applied && !titleSkipped(c.title, skipTitles) && !tried.has(cardKey(c)));
}

export const cardKey = (c: Pick<JobCard, 'title' | 'company'>) => `${c.company}|${c.title}`.toLowerCase();

/** The job pane's Easy Apply button, once the selected job has loaded. */
export function easyApplyButton(doc: Document = document): HTMLElement | null {
  const b = [...doc.querySelectorAll<HTMLElement>('button[aria-label="Easy Apply to this job"], button[aria-label^="Easy Apply to "]')].find((x) => isVisible(x) && !(x as HTMLButtonElement).disabled);
  return b ?? null;
}

/** The job pane shows this job: its title appears outside the list of cards. */
export function paneShowsTitle(title: string, doc: Document = document): boolean {
  const t = title.replace(/\s+/g, ' ').trim();
  return [...doc.querySelectorAll('a, h1, h2, h3')].some(
    (e) => (e.textContent || '').replace(/\s+/g, ' ').trim() === t && !e.closest('[role="button"][componentkey]') && isVisible(e),
  );
}

/** The job id LinkedIn shows: ?currentJobId= on the list, /jobs/view/<id>/ on a job page. */
export const currentJobId = (href: string) => {
  try {
    const u = new URL(href);
    return u.searchParams.get('currentJobId') || (u.pathname.match(/jobs\/view\/(\d+)/) || [])[1] || '';
  } catch {
    return '';
  }
};

/** The job pane says this job is already applied to (no Easy Apply to press). */
export function paneShowsApplied(doc: Document = document): boolean {
  return [...doc.querySelectorAll('h1,h2,h3')].some((h) => /^application status$/i.test((h.textContent || '').trim()));
}

/** The next page of results, if any. */
export function nextPageButton(doc: Document = document): HTMLElement | null {
  const b = doc.querySelector<HTMLElement>('[data-testid="pagination-controls-next-button-visible"], button[aria-label="View next page"]');
  return b && isVisible(b) && !(b as HTMLButtonElement).disabled ? b : null;
}

/** The open Easy Apply dialog (it may sit in a closed shadow root). */
export function applyDialog(doc: Document = document): Element | null {
  const ds = openDialogs(doc).filter((d) => /apply to |submit application|application (was )?sent|review your application|contact info/i.test(d.textContent || '') || d.querySelector('input,select,textarea'));
  return ds.at(-1) ?? null;
}

/** LinkedIn's "Your application was sent" dialog. */
export function isSentDialog(d: Element | null): boolean {
  return !!d && (CONFIRMATION_RE.test((d.textContent || '').replace(/\s+/g, ' ')) || /application sent/i.test(d.textContent || ''));
}

/** The button that closes the "application sent" dialog (Done / Dismiss / Close / Not now). */
export function closeButton(d: Element): HTMLElement | null {
  const bs = [...d.querySelectorAll<HTMLElement>('button')].filter((b) => isVisible(b));
  return (
    bs.find((b) => /^(done|not now|close)$/i.test((b.textContent || '').trim())) ??
    bs.find((b) => /^(dismiss|close)/i.test(b.getAttribute('aria-label') || '')) ??
    null
  );
}

/** Today's date in local time, for the daily count. */
export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A pause that doesn't look like a script: base seconds ± 50%. */
export const jitter = (baseSec: number) => Math.max(0, baseSec * 1000 * (0.5 + Math.random()));

/** Is this a LinkedIn page with a job list the queue can work through? */
export const isLinkedInJobList = (href: string) => /linkedin\.com\/jobs\/(search|search-results|collections)/.test(href);
