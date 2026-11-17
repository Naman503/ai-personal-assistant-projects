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
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The card's text lines, in order. Real pages are laid out, so innerText has them; where it
 * isn't (tests), fall back to the text of each innermost element. Never both: mixing them
 * repeats the title and the company is then misread.
 */
export const cardLines = (el: HTMLElement): string[] => {
  const rendered = (el.innerText || '').split('\n').map(clean).filter(Boolean);
  if (rendered.length >= 3) return rendered;
  return [...el.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => clean(e.textContent || '')).filter(Boolean);
};

/** The company: the first line after the title that isn't the title again ("Title (Verified job)", "Title"). */
export function companyFrom(lines: string[], title: string): string {
  const t = title.toLowerCase();
  const i = lines.findIndex((l) => l.toLowerCase().startsWith(t));
  for (const l of lines.slice(i + 1)) {
    const x = l.toLowerCase();
    if (x.startsWith(t) || x === 'verified job' || x === '·') continue;
    return l;
  }
  return '';
}

/** Job cards in the list on the left, top to bottom. */
export function jobCards(doc: Document = document): JobCard[] {
  const out: JobCard[] = [];
  for (const btn of doc.querySelectorAll<HTMLElement>(DISMISS)) {
    // The clickable card: the nearest [role=button] that holds this one Dismiss button.
    let card = btn.parentElement;
    while (card && !(card.getAttribute('role') === 'button' && card.querySelectorAll(DISMISS).length === 1)) card = card.parentElement;
    if (!card || card.querySelectorAll(DISMISS).length !== 1) continue;
    const title = clean((btn.getAttribute('aria-label') || '').replace(/^Dismiss /, '').replace(/ job$/, ''));
    const ls = cardLines(card);
    // Badges: any innermost element or rendered line saying exactly "Applied" / "Easy Apply".
    const tags = new Set([...ls, ...[...card.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => clean(e.textContent || ''))]);
    out.push({ el: card, title, company: companyFrom(ls, title), applied: tags.has('Applied'), easyApply: tags.has('Easy Apply') });
  }
  return out;
}

/** The element that scrolls the job list (LinkedIn loads more cards as it scrolls). */
export function listScroller(from: Element | undefined): HTMLElement | null {
  let p = from?.parentElement ?? null;
  while (p && p !== document.body) {
    const oy = getComputedStyle(p).overflowY;
    if (/(auto|scroll)/.test(oy) && p.scrollHeight > p.clientHeight + 20) return p;
    p = p.parentElement;
  }
  return null;
}

/** "Softnotions Technologies Private Limited" → "softnotions" core words, for loose matching. */
const SUFFIX = /\b(pvt|private|ltd|limited|inc|llp|llc|corp|corporation|co|company|technologies|technology|tech|solutions|services|software|india|group|labs?|the)\b/g;
export const companyKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
export function sameCompany(a: string, b: string): boolean {
  const x = companyKey(a), y = companyKey(b);
  if (!x || !y) return true; // unknown on one side: nothing to contradict
  return x === y || x.includes(y) || y.includes(x) || x.split(' ')[0] === y.split(' ')[0];
}

/** The company the job pane (or the address LinkedIn sets after Easy Apply) is about. */
export function paneCompany(doc: Document = document, href = location.href): string {
  try {
    const c = new URL(href).searchParams.get('companyName');
    if (c) return clean(c);
  } catch {
    /* ignore */
  }
  const a = [...doc.querySelectorAll<HTMLElement>('a[href*="/company/"]')].find((e) => !e.closest('[role="button"][componentkey]') && clean(e.innerText || e.textContent || ''));
  return a ? clean((a.innerText || a.textContent || '').split('\n')[0]) : '';
}

/** "Apply to <Company>" from the Easy Apply dialog's heading. */
export function dialogCompany(d: Element | null): string {
  if (!d) return '';
  const h = [...d.querySelectorAll('h1,h2,h3,[id*="header"],span,div')].find((e) => /^apply to /i.test(clean(e.textContent || '')) && clean(e.textContent || '').length < 160);
  return h ? clean(h.textContent || '').replace(/^apply to /i, '') : '';
}

/** The dialog has finished loading its step: a field or a Next / Review / Submit button. */
export function dialogReady(d: Element | null): boolean {
  if (!d) return false;
  if (d.querySelector('input:not([type=hidden]),select,textarea')) return true;
  return [...d.querySelectorAll('button')].some((b) => /^(next|continue|review|submit application|submit)$/i.test(clean(b.textContent || '')));
}

/** LinkedIn is pushing back: a limit notice, a security check or a sign-in wall. Stop for the day. */
export function pushbackNotice(doc: Document = document, href = location.href): string {
  if (/linkedin\.com\/(checkpoint|authwall|login|uas\/login)/.test(href)) return 'LinkedIn wants you to verify or sign in';
  const t = (doc.body?.innerText || '').slice(0, 20000);
  // 17 Nov 2026, live: a <dialog data-testid="dialog"> "You reached today’s Easy Apply limit … Save
  // this job and continue applying tomorrow." with Got it / Learn more.
  const m = t.match(/(reached (the|your|today.s) (daily )?(easy apply|application|apply) limit|easy apply limit|continue applying tomorrow|you.ve reached the limit|too many (requests|applications)|unusual activity|let.s do a quick security check)/i);
  return m ? `LinkedIn says: "${m[0]}"` : '';
}

/** A daily limit (back tomorrow) or a security / sign-in wall (needs you to look). */
export function pushbackKind(msg: string): 'limit' | 'security' {
  return /limit|tomorrow|too many applications/i.test(msg) && !/security|verify|sign in|captcha|unusual/i.test(msg) ? 'limit' : 'security';
}

/**
 * Click like a person: the pointer moves onto the element, presses and releases near its
 * middle (not dead centre), then the click. Synthetic events are never "trusted", so what
 * really matters is pace and volume; this just avoids a bare .click() with no pointer events.
 */
export function humanClick(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width * (0.35 + Math.random() * 0.3);
  const y = r.top + r.height * (0.35 + Math.random() * 0.3);
  const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  const p = { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerover', p));
  el.dispatchEvent(new MouseEvent('mouseover', o));
  el.dispatchEvent(new PointerEvent('pointermove', p));
  el.dispatchEvent(new MouseEvent('mousemove', o));
  el.dispatchEvent(new PointerEvent('pointerdown', { ...p, button: 0, buttons: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...o, button: 0, buttons: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup', { ...p, button: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { ...o, button: 0 }));
  el.click();
}

/** A random whole number of milliseconds between a and b seconds. */
export const between = (a: number, b: number) => Math.round((a + Math.random() * (b - a)) * 1000);

/** "Engineering Manager, Director" → true for titles containing any of them. */
/**
 * A skip word matches as a whole word ("Java" doesn't skip "JavaScript", "SAP" doesn't skip
 * "Sapient"; 18 Nov: Naukri JavaScript jobs were skipped for "JAVA"). Words with symbols
 * (".Net", "C#") match as written.
 */
export function titleSkipped(title: string, skip: string): boolean {
  const t = title.toLowerCase();
  return skip
    .split(/[,\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((s) => {
      if (/[^a-z0-9 ]/.test(s)) return t.includes(s);
      return new RegExp(`(^|[^a-z0-9])${s.replace(/\s+/g, '\\s+')}([^a-z0-9]|$)`).test(t);
    });
}

/** Cards worth opening: Easy Apply, not applied, not skipped by title, not already tried. */
export function candidates(cards: JobCard[], skipTitles: string, tried: Set<string>, relevant: string[] = []): JobCard[] {
  return cards.filter((c) => c.easyApply && !c.applied && !titleSkipped(c.title, skipTitles) && !tried.has(cardKey(c)) && titleRelevant(c.title, relevant));
}

/** Words too common in job titles to say what the job is. */
const GENERIC = new Set(['developer', 'engineer', 'engineering', 'senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'associate', 'ii', 'iii', 'iv', 'i', 'and', 'or', 'the', 'of', 'for', 'with', 'remote', 'hybrid', 'onsite', 'manager', 'specialist', 'consultant', 'intern', 'trainee', 'executive', 'sde', 'application', 'applications', 'app', 'apps']);
/** Lower-case words, with "Full-Stack"/"Fullstack" → "full stack" and "React.js"/"ReactJS" → "react". */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/full[\s-]?stack/g, 'full stack')
    .replace(/react[\s.]?js\b/g, 'react')
    .replace(/node[\s.]?js\b/g, 'node')
    .replace(/front[\s-]?end/g, 'frontend')
    .replace(/back[\s-]?end/g, 'backend')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();

/**
 * What your job titles are about, as phrases: "React Native Developer, Full Stack Engineer,
 * Mobile Engineer" → "react native", "full stack", "mobile". A job title matches a phrase only
 * as a whole ("AI-Native Developer" is not "react native").
 */
/**
 * Close relatives of your phrases that mean the same job (18 Nov: "React JS + Node JS Developer"
 * on Naukri's Recommended list was left out for not saying "React Native" or "Full Stack").
 */
const RELATED: Record<string, string[]> = {
  'react native': ['react', 'expo'],
  'full stack': ['mern', 'mean', 'node', 'frontend', 'react', 'typescript', 'javascript'],
  python: ['fastapi', 'django', 'flask'],
  fastapi: ['python'],
  mobile: ['react native', 'expo'],
};

export function relevantWords(titles: string[]): string[] {
  const out = titles.map((t) => norm(t).split(' ').filter((w) => w && !GENERIC.has(w)).join(' ')).filter(Boolean);
  return [...new Set(out.flatMap((p) => [p, ...(RELATED[p] ?? [])]))];
}

/** A job title matches when it contains one of your phrases (no phrases: everything matches). */
export function titleRelevant(title: string, relevant: string[]): boolean {
  if (!relevant.length) return true;
  const t = ` ${norm(title)} `;
  return relevant.some((p) => t.includes(` ${norm(p)} `));
}

export const cardKey = (c: Pick<JobCard, 'title' | 'company'>) => `${c.company}|${c.title}`.toLowerCase();

/**
 * The job pane's Easy Apply control, once the selected job has loaded. Since the evening of
 * 17 Nov 2026 LinkedIn renders it as a link (`<a aria-label="Easy Apply to this job" href=<this
 * search>>`), before that as a button; both open the dialog in place.
 */
export function easyApplyButton(doc: Document = document): HTMLElement | null {
  const sel = ['button', 'a'].map((t) => `${t}[aria-label="Easy Apply to this job"], ${t}[aria-label^="Easy Apply to "]`).join(', ');
  const b = [...doc.querySelectorAll<HTMLElement>(sel)].find((x) => isVisible(x) && !(x as HTMLButtonElement).disabled && x.getAttribute('aria-disabled') !== 'true');
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

/**
 * A pop-up with no form in it that sits over the job list (after "application sent": "Turn your
 * resume into a profile…", Premium, job alerts): its decline button. Never the action button
 * ("Update profile", "Try Premium"), and never a dialog that holds an application form.
 */
export function upsellDecline(d: Element): HTMLElement | null {
  if (d.querySelector('input:not([type=hidden]),select,textarea')) return null;
  const bs = [...d.querySelectorAll<HTMLElement>('button')].filter((b) => isVisible(b));
  return (
    bs.find((b) => /^(not now|no,? thanks|maybe later|skip( for now)?|done|got it)$/i.test((b.textContent || '').replace(/\s+/g, ' ').trim())) ??
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
