/**
 * LinkedIn outreach, page side. The tracker decides what to do (lib/outreach-runner.ts asks it);
 * this file does one task on the page the runner opened:
 *
 *  - find-people: on a job page, read "Meet the hiring team" (name, title, profile link).
 *  - connect:     on a profile, send a connection request with the note (or without one when
 *                 LinkedIn has no personalised invites left); reports pending / already connected.
 *  - check:       on a profile, has the request been accepted?
 *  - message:     on a 1st-degree profile, open Message and send the text.
 *
 * Dry run does everything up to the Send button and stops. Selectors lean on aria-labels and
 * visible text, which LinkedIn changes far less often than class names.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('outreach');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const human = (a: number, b: number) => sleep(a + Math.random() * (b - a));
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export type OutreachTask =
  | { task: 'find-people'; appId: string; url: string; company?: string; role?: string }
  | { task: 'connect'; id: string; name?: string; profile: string; note: string; dryRun?: boolean }
  | { task: 'check'; id: string; name?: string; profile: string }
  | { task: 'message'; id: string; name?: string; profile: string; text: string; dryRun?: boolean };

export interface OutreachResult {
  outcome: 'sent' | 'sent-no-note' | 'pending' | 'connected' | 'not-connected' | 'dry' | 'failed' | 'limit' | 'done';
  detail?: string;
  people?: { name: string; title: string; profile: string }[];
}

async function until<T>(get: () => T | null | undefined | false, ms: number, every = 400): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

const shown = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).getClientRects().length > 0;
const label = (el: Element) => clean(el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.textContent);

/** Buttons (and menu items acting as buttons) inside `root` whose label matches. */
function buttons(root: ParentNode, re: RegExp): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"], a[role="button"]')].filter((b) => re.test(label(b)) && !(b as HTMLButtonElement).disabled);
}

/** LinkedIn stopping us: security check, sign-in wall, invitation limit. */
export function pushback(doc: Document = document): string | null {
  if (/\/checkpoint\/|\/authwall|\/login/.test(location.pathname)) return 'LinkedIn showed a security check or sign-in page';
  const t = clean(doc.body?.innerText).slice(0, 20000);
  if (/weekly invitation limit|reached the weekly limit|you've reached the (weekly )?limit/i.test(t)) return "LinkedIn's weekly invitation limit";
  if (/unusual activity|restricted your account|temporarily restricted/i.test(t)) return 'LinkedIn flagged unusual activity';
  return null;
}

/* ---------------- job page: hiring team ---------------- */

const profileHref = (a: HTMLAnchorElement) => {
  const m = a.href.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}/` : '';
};

/** "Meet the hiring team" / "People you can reach out to" on a job page. */
export function readHiringTeam(doc: Document = document): { name: string; title: string; profile: string }[] {
  const heads = [...doc.querySelectorAll('h2, h3, span, div')].filter((h) => h.children.length <= 2 && /^(meet the hiring team|people you can reach out to|job poster)$/i.test(clean(h.textContent)));
  const roots = new Set<Element>();
  for (const h of heads) {
    // Climb to the block that holds the profile links.
    let el: Element | null = h;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) if (el.querySelector('a[href*="/in/"]')) break;
    if (el) roots.add(el);
  }
  for (const sel of ['.hirer-card__hirer-information', '.job-details-people-who-can-help__section--two-pane', '[class*="hirer-card"]']) for (const el of doc.querySelectorAll(sel)) roots.add(el);
  const out = new Map<string, { name: string; title: string; profile: string }>();
  for (const root of roots) {
    for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')) {
      const profile = profileHref(a);
      if (!profile || out.has(profile)) continue;
      const lines = (s: string) => s.split(/\n+/).map(clean).filter((x) => x && !/^(·|•)?\s*(1st|2nd|3rd\+?|3rd)$|^(job poster|message|connect|follow|view profile|premium|verified)$/i.test(x));
      const name = clean(a.querySelector('strong, span[aria-hidden="true"]')?.textContent) || lines(a.innerText || a.textContent || '')[0] || '';
      // The card around this link holds the title under the name.
      let card: Element | null = a;
      for (let i = 0; i < 4 && card?.parentElement; i++) { card = card.parentElement; if (lines((card as HTMLElement).innerText || card.textContent || '').length >= 2) break; }
      const rest = lines((card as HTMLElement)?.innerText || card?.textContent || '').filter((x) => x !== name && !x.startsWith(name + ' '));
      const title = rest.find((x) => x.length > 3 && !/^(meet the hiring team|people you can reach out to)$/i.test(x)) ?? '';
      if (name && name.length < 80) out.set(profile, { name: name.replace(/\s*(·|•).*$/, ''), title: title.slice(0, 160), profile });
    }
  }
  return [...out.values()].slice(0, 3);
}

/* ---------------- profile page ---------------- */

/** The profile's top card: the section around the name. */
function topCard(doc: Document = document): HTMLElement | null {
  const h1 = doc.querySelector('main h1');
  if (!h1) return null;
  return (h1.closest('section') as HTMLElement) ?? (h1.parentElement?.parentElement?.parentElement as HTMLElement) ?? null;
}

export type Degree = 'connected' | 'pending' | 'can-connect' | 'unknown';

export function profileState(doc: Document = document): { state: Degree; connect?: HTMLElement; more?: HTMLElement; message?: HTMLElement } {
  const card = topCard(doc);
  if (!card) return { state: 'unknown' };
  const text = clean(card.innerText || card.textContent);
  const pending = buttons(card, /^pending|withdraw invitation/i)[0];
  if (pending) return { state: 'pending' };
  const message = buttons(card, /^message\b/i)[0];
  if (/(^|[\s·•])1st\b/.test(text) || card.querySelector('.dist-value')?.textContent?.includes('1st')) return { state: 'connected', message };
  const connect = buttons(card, /^invite .* to connect$|^connect$/i)[0];
  const more = buttons(card, /^more( actions)?$/i)[0];
  return { state: connect || more ? 'can-connect' : 'unknown', connect, more, message };
}

function dialog(): HTMLElement | null {
  const ds = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], .artdeco-modal')].filter(shown);
  return ds[ds.length - 1] ?? null;
}
async function closeDialog() {
  const d = dialog();
  const x = d && buttons(d, /^dismiss$|^close$|^cancel$/i)[0];
  if (x) x.click();
  else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(600);
}

function setText(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Find the Connect control: on the card, or in the card's "More" menu. */
async function findConnect(): Promise<HTMLElement | null> {
  const st = profileState();
  if (st.connect) return st.connect;
  if (!st.more) return null;
  st.more.click();
  await human(700, 1200);
  // The menu is a dropdown next to the button (sometimes rendered at the end of <body>).
  const item = await until(() => buttons(document, /^invite .* to connect$|^connect$/i).find(shown), 3000);
  if (!item) {
    st.more.click(); // close the menu again
    await sleep(400);
  }
  return item;
}

async function connect(note: string, dryRun: boolean): Promise<OutreachResult> {
  const st = profileState();
  if (st.state === 'pending') return { outcome: 'pending' };
  if (st.state === 'connected') return { outcome: 'connected' };
  const btn = await findConnect();
  if (!btn) return { outcome: 'failed', detail: 'no Connect button on this profile (Follow only, or the page changed)' };
  if (dryRun) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { outcome: 'dry', detail: `Connect found; note ${note.length} characters` };
  }
  btn.click();
  const d = await until(dialog, 6000);
  if (!d) return { outcome: 'failed', detail: 'the invite dialog did not open' };
  await human(600, 1100);
  if (d.querySelector('input[type="email"]')) {
    await closeDialog();
    return { outcome: 'failed', detail: 'LinkedIn wants their email address to connect' };
  }
  const addNote = buttons(d, /^add a note$/i)[0];
  let withNote = false;
  if (addNote && note) {
    addNote.click();
    const box = await until(() => dialog()?.querySelector<HTMLTextAreaElement>('textarea[name="message"], textarea#custom-message, textarea'), 4000);
    if (box) {
      box.focus();
      setText(box, note.slice(0, 300));
      await human(900, 1600);
      withNote = true;
    } else {
      // Free accounts get only a few personalised invites a month: send it without a note.
      await closeDialog();
      const again = await findConnect();
      if (!again) return { outcome: 'failed', detail: 'no personalised invites left and Connect disappeared' };
      again.click();
      await until(dialog, 5000);
      await human(500, 900);
    }
  }
  const dd = dialog();
  const send = dd && (buttons(dd, withNote ? /^send( invitation| now)?$/i : /^send without a note$|^send( now| invitation)?$/i)[0] ?? null);
  if (!send) {
    await closeDialog();
    return { outcome: 'failed', detail: 'no Send button in the invite dialog' };
  }
  send.click();
  await human(1500, 2500);
  const push = pushback();
  if (push) {
    await closeDialog();
    return { outcome: 'limit', detail: push };
  }
  if (dialog()) await closeDialog();
  const after = profileState();
  if (after.state === 'pending' || after.state === 'connected') return { outcome: withNote ? 'sent' : 'sent-no-note' };
  return { outcome: withNote ? 'sent' : 'sent-no-note', detail: "sent, but the page didn't show Pending" };
}

async function message(text: string, dryRun: boolean): Promise<OutreachResult> {
  const st = profileState();
  if (st.state !== 'connected') return { outcome: 'failed', detail: st.state === 'pending' ? 'not accepted yet' : 'not connected' };
  if (!st.message) return { outcome: 'failed', detail: 'no Message button' };
  st.message.click();
  const box = await until(() => [...document.querySelectorAll<HTMLElement>('.msg-form__contenteditable[contenteditable="true"], [role="textbox"][contenteditable="true"]')].filter(shown).pop(), 8000);
  if (!box) return { outcome: 'failed', detail: 'the message box did not open' };
  await human(800, 1400);
  if (dryRun) {
    const close = buttons(document, /^close your (conversation|draft)|^close$/i).find(shown);
    close?.click();
    return { outcome: 'dry', detail: `message box open; ${text.length} characters` };
  }
  box.focus();
  // A rich-text box: insertText keeps LinkedIn's editor state in sync.
  if (!document.execCommand('insertText', false, text)) {
    box.textContent = text;
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  await human(1000, 1800);
  const form = box.closest('form') ?? document;
  const send = await until(() => [...form.querySelectorAll<HTMLButtonElement>('button.msg-form__send-button, button[type="submit"]')].find((b) => shown(b) && !b.disabled && /send/i.test(label(b))), 4000);
  if (!send) return { outcome: 'failed', detail: 'Send stayed disabled' };
  send.click();
  await human(1500, 2500);
  const push = pushback();
  if (push) return { outcome: 'limit', detail: push };
  buttons(document, /^close your conversation/i).find(shown)?.click();
  return { outcome: 'sent' };
}

/** Run one task on this page. The page must already be the right one (the runner navigated). */
export async function runOutreach(t: OutreachTask): Promise<OutreachResult> {
  const push = pushback();
  if (push) return { outcome: 'limit', detail: push };
  try {
    if (t.task === 'find-people') {
      // The job details load after the shell; the hiring team card a little later still.
      await until(() => document.querySelector('main h1, .job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card'), 15000);
      window.scrollBy(0, 600);
      const people = (await until(() => { const p = readHiringTeam(); return p.length ? p : null; }, 8000)) ?? [];
      log.info(`hiring team: ${people.length}`, people);
      return { outcome: 'done', people };
    }
    const ok = await until(() => topCard(), 15000);
    if (!ok) return { outcome: 'failed', detail: "the profile didn't load" };
    await human(800, 1500);
    if (t.task === 'check') {
      const s = profileState().state;
      return { outcome: s === 'connected' ? 'connected' : s === 'pending' ? 'pending' : s === 'can-connect' ? 'not-connected' : 'failed', detail: s };
    }
    if (t.task === 'connect') return await connect(t.note, !!t.dryRun);
    if (t.task === 'message') return await message(t.text, !!t.dryRun);
    return { outcome: 'failed', detail: 'unknown task' };
  } catch (e) {
    return { outcome: 'failed', detail: (e as Error).message };
  }
}
