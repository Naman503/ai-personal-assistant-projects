/**
 * Apply queue (LinkedIn): go down the job list, open each Easy Apply job you haven't applied
 * to, fill it and press Next to the Submit button, then wait for YOU to press Submit. After the
 * application is sent, close LinkedIn's confirmation, pause a few seconds and open the next.
 * It never presses Submit. A step that needs you (a blank required field, an error) waits;
 * once you move past it, the queue takes over again.
 */
import {
  applyDialog,
  between,
  candidates,
  cardKey,
  closeButton,
  currentJobId,
  dialogCompany,
  dialogReady,
  easyApplyButton,
  humanClick,
  isSentDialog,
  jitter,
  jobCards,
  listScroller,
  nextPageButton,
  paneCompany,
  paneShowsApplied,
  paneShowsTitle,
  pushbackNotice,
  sameCompany,
  today,
  type JobCard,
} from '@/lib/queue';
import { decideStep, settled } from '@/lib/walk';
import { dialogAnchor } from '@/lib/fields/context';
import { createLogger } from '@/lib/logger';
import { quietFocus } from '@/lib/automation';
import type { WalkOutcome } from './walk';

const log = createLogger('content:queue');

/**
 * Log a queue step and send it to Options → Logs too (content-script info logs normally stay
 * in the page console), so a run that went wrong can be read back afterwards.
 */
function trace(msg: string, data?: unknown) {
  log.info(msg, data);
  try {
    void chrome.runtime.sendMessage({ type: 'log', entry: { t: Date.now(), level: 'info', ns: 'queue', msg, data, ctx: 'content' } }).catch(() => {});
  } catch {
    /* extension reloaded */
  }
}
const DAY_KEY = 'fpQueueDay';

type Action = { label: string; run: () => void; primary?: boolean };
type Toast = (text: string, tone: 'info' | 'success' | 'error', action?: Action | Action[], ms?: number) => void;

export interface QueuePrefs {
  cap: number;
  delaySec: number;
  skipTitles: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ApplyQueue {
  private running = false;
  private stopRequested = false;
  private skipRequested = false;
  private tried = new Set<string>();
  private sent = 0;
  /** Sent since the last break; a longer pause comes after a handful, like a person would take. */
  private sinceBreak = 0;
  private breakAfter = 0;

  constructor(
    private deps: {
      prefs: () => QueuePrefs;
      fill: (anchor: HTMLElement) => Promise<{ filled: number; total: number }>;
      walk: (anchor: HTMLElement) => Promise<WalkOutcome>;
      blockedReason: () => string;
      toast: Toast;
    },
  ) {}

  get active() {
    return this.running;
  }

  stop() {
    this.stopRequested = true;
  }

  async start() {
    if (this.running) return this.status('The apply queue is already running.', 'info');
    this.running = true;
    this.stopRequested = false;
    this.sent = 0;
    this.sinceBreak = 0;
    this.breakAfter = 6 + Math.floor(Math.random() * 5);
    try {
      await this.loop();
    } catch (e) {
      log.warn('queue failed', e);
      this.deps.toast(`Apply queue stopped: ${(e as Error).message}`, 'error', undefined, 15_000);
    } finally {
      this.running = false;
    }
  }

  private bar(): Action[] {
    return [
      { label: 'Skip', run: () => (this.skipRequested = true) },
      { label: 'Stop', run: () => this.stop() },
    ];
  }

  private status(text: string, tone: 'info' | 'success' | 'error' = 'info', ms = 10 * 60_000) {
    this.deps.toast(text, tone, this.running ? this.bar() : undefined, ms);
  }

  private async countToday(add = 0): Promise<number> {
    const t = today();
    const got = (await chrome.storage.local.get(DAY_KEY))[DAY_KEY] as { date: string; n: number } | undefined;
    const n = (got?.date === t ? got.n : 0) + add;
    if (add) await chrome.storage.local.set({ [DAY_KEY]: { date: t, n } });
    return n;
  }

  private async loop() {
    const prefs = this.deps.prefs();
    trace(`queue started on ${location.pathname}`, { cap: prefs.cap, delaySec: prefs.delaySec, skip: prefs.skipTitles });
    for (let page = 0; page < 10 && !this.stopRequested; page++) {
      await this.loadWholeList();
      let list = candidates(jobCards(), prefs.skipTitles, this.tried);
      const all = jobCards();
      trace(`page ${page + 1}: ${all.length} cards, ${list.length} to open`, all.map((c) => `${c.applied ? 'A' : '-'}${c.easyApply ? 'E' : '-'} ${c.title} · ${c.company}`));
      if (!all.length && page === 0) return this.finish('No job list found on this page. Open a LinkedIn job search first.');
      while (list.length && !this.stopRequested) {
        const push = pushbackNotice();
        if (push) return this.finish(`${push}. Stopped for today so your account stays safe.`, 'error');
        if ((await this.countToday()) >= prefs.cap) return this.finish(`Daily limit reached (${prefs.cap}). Change it in FormPilot settings → Behavior.`);
        const card = list[0];
        this.tried.add(cardKey(card));
        const sent = await this.one(card, prefs);
        if (this.stopRequested) break;
        if (sent && ++this.sinceBreak >= this.breakAfter) {
          await this.rest(between(60, 150));
          this.sinceBreak = 0;
          this.breakAfter = 6 + Math.floor(Math.random() * 5);
        } else await this.pause(sent ? jitter(Math.max(prefs.delaySec, 4)) : between(2, 4));
        list = candidates(jobCards(), prefs.skipTitles, this.tried);
        if (!list.length) {
          await this.loadWholeList();
          list = candidates(jobCards(), prefs.skipTitles, this.tried);
        }
      }
      if (this.stopRequested) break;
      const next = nextPageButton();
      if (!next) break;
      const firstBefore = jobCards()[0]?.title;
      this.status('Opening the next page of jobs…');
      await this.pause(between(2, 5));
      next.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await this.pause(between(0.6, 1.2));
      humanClick(next);
      await this.until(() => (jobCards()[0]?.title ?? '') !== firstBefore, 20_000);
      await this.pause(between(1.5, 3));
    }
    this.finish(this.stopRequested ? `Apply queue stopped. ${this.sent} sent this run.` : `Done with this list. ${this.sent} sent this run.`);
  }

  /** LinkedIn shows the first few cards and loads the rest as the list scrolls: scroll it like a reader. */
  private async loadWholeList() {
    const scroller = listScroller(jobCards()[0]?.el);
    if (!scroller) return;
    let count = jobCards().length;
    let still = 0;
    for (let i = 0; i < 20 && still < 2 && !this.stopRequested; i++) {
      scroller.scrollBy({ top: 350 + Math.random() * 300, behavior: 'smooth' });
      await sleep(between(0.6, 1.3));
      const n = jobCards().length;
      still = n === count && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8 ? still + 1 : 0;
      count = n;
    }
    scroller.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(between(0.5, 1));
    trace(`list loaded: ${count} cards`);
  }

  /** A pause that the Stop button cuts short. */
  private async pause(ms: number) {
    await this.until(() => false, ms, 250);
  }

  /** A longer break after a handful of applications, with a countdown and a way to skip it. */
  private async rest(ms: number) {
    trace(`taking a ${Math.round(ms / 1000)} s break`);
    const end = Date.now() + ms;
    let skip = false;
    while (Date.now() < end && !this.stopRequested && !skip) {
      const left = Math.ceil((end - Date.now()) / 1000);
      this.deps.toast(`Short break so this looks like a person applying · next job in ${left} s`, 'info', [
        { label: 'Go now', run: () => (skip = true) },
        { label: 'Stop', run: () => this.stop() },
      ], 2000);
      await sleep(1000);
    }
  }

  private finish(msg: string, tone: 'success' | 'error' = 'success') {
    trace(`queue finished: ${msg}`);
    this.running = false;
    this.deps.toast(msg, tone, undefined, tone === 'error' ? 60_000 : 12_000);
  }

  /** Wait until `cond` holds, or `ms` passes. */
  private async until(cond: () => boolean, ms: number, every = 400) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.stopRequested) return false;
      if (cond()) return true;
      await sleep(every);
    }
    return cond();
  }

  /** One job: open it, read it, Easy Apply, fill to Submit, wait for the user. True if it was sent. */
  private async one(card: JobCard, prefs: QueuePrefs): Promise<boolean> {
    this.skipRequested = false;
    const label = `${card.title}${card.company ? ` · ${card.company}` : ''}`;
    const n = (await this.countToday()) + 1;
    this.status(`${n} of ${prefs.cap} today · Opening ${label}`);
    card.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await this.pause(between(0.5, 1.1));
    if (this.stopRequested) return false;
    const before = { id: currentJobId(location.href), btn: easyApplyButton() };
    trace(`opening: ${label}`, { from: before.id });
    humanClick(card.el);
    // The job pane takes a few seconds and keeps the old job's Easy Apply button until the new
    // job loads: wait for the job id to change and the pane to show this job's title.
    const loaded = () => (currentJobId(location.href) !== before.id || !before.btn?.isConnected) && paneShowsTitle(card.title) && (!!easyApplyButton() || paneShowsApplied());
    if (!(await this.until(loaded, 30_000))) {
      if (!this.stopRequested) trace(`skip: the job pane didn't load ${label} within 30 s`, { id: currentJobId(location.href), title: paneShowsTitle(card.title), easy: !!easyApplyButton() });
      return false;
    }
    if (!easyApplyButton()) {
      trace(`skip: no Easy Apply button for ${label} (already applied or external)`);
      return false;
    }
    // Look at the job for a moment before applying, as a person would.
    this.status(`${n} of ${prefs.cap} today · Reading ${label}`);
    await this.pause(between(2, 5));
    if (this.stopRequested) return false;
    const company = paneCompany() || card.company;
    const jobId = currentJobId(location.href);
    // Press Easy Apply; if nothing opens, press it once more (the first press can land mid-render).
    let dialog = false;
    for (let attempt = 0; attempt < 2 && !dialog && !this.stopRequested; attempt++) {
      const b = easyApplyButton();
      if (!b) break;
      quietFocus(8000); // the dialog focuses its first field on open: not a reason to suggest
      humanClick(b);
      dialog = await this.until(() => !!applyDialog(), attempt ? 15_000 : 8000);
    }
    if (this.stopRequested) return false;
    if (!dialog) {
      trace(`skip: the Easy Apply dialog didn't open for ${label}`);
      return false;
    }
    // The dialog frame opens first and its step loads after: wait for fields or a Next button.
    if (!(await this.until(() => dialogReady(applyDialog()), 20_000))) {
      if (this.stopRequested) return false;
      trace(`the dialog for ${label} has no fields or buttons after 20 s; leaving it to you`);
    }
    // Safety: the dialog must be for this job's company ("Apply to <Company>").
    const forCompany = dialogCompany(applyDialog());
    if (company && forCompany && !sameCompany(company, forCompany)) {
      trace(`skip: the dialog is for "${forCompany}", not "${company}" (${label})`);
      await this.discard(applyDialog());
      return false;
    }
    trace(`dialog open for ${label}`, { jobId, company, dialog: forCompany, url: location.pathname });
    await settled(document, 500, 3000);
    await this.pause(between(0.4, 1));
    return this.drive(label, n, prefs);
  }

  /** Fill and walk the open dialog; then wait for the user to submit, skip or close it. */
  private async drive(label: string, n: number, prefs: QueuePrefs): Promise<boolean> {
    let fingerprint = '';
    let outcome = 'none' as WalkOutcome;
    const step = async () => {
      const anchor = dialogAnchor() ?? (applyDialog() as HTMLElement | null);
      if (!anchor) return;
      const f = await this.deps.fill(anchor);
      outcome = await this.deps.walk(anchor);
      fingerprint = this.stepFingerprint();
      trace(`filled ${f.filled}/${f.total}; walk stopped: ${outcome}${outcome === 'blocked' ? ` (${this.deps.blockedReason()})` : ''}`, { step: fingerprint.slice(0, 200) });
      if (outcome === 'submit') this.status(`${n} of ${prefs.cap} today · ${label} — Ready: check the answers and press Submit.`, 'success');
      else if (outcome === 'blocked') this.status(`${n} of ${prefs.cap} today · ${label} — ${this.deps.blockedReason()}. Fill it in and press Next; I'll take over again.`);
      else this.status(`${n} of ${prefs.cap} today · ${label} — Finish this one by hand, or Skip.`);
    };
    await step();
    // Wait for the user. Up to 15 minutes per job.
    const end = Date.now() + 15 * 60_000;
    while (Date.now() < end && !this.stopRequested) {
      await sleep(700);
      const d = applyDialog();
      if (isSentDialog(d)) {
        this.sent++;
        const total = await this.countToday(1);
        trace(`sent: ${label} (${total} today)`);
        this.status(`Sent: ${label}. ${total} of ${prefs.cap} today. Next one in a moment…`, 'success', 8000);
        await sleep(1200);
        const close = d && closeButton(d);
        if (close) humanClick(close);
        await this.until(() => !isSentDialog(applyDialog()), 5000);
        return true;
      }
      if (!d) {
        trace(`dialog closed without sending: ${label}`);
        return false; // the user closed or discarded it
      }
      if (this.skipRequested) {
        trace(`skipped by you: ${label}`);
        await this.discard(d);
        return false;
      }
      // The user moved past a step that needed them: take over again.
      if ((outcome as WalkOutcome) !== 'submit') {
        const fp = this.stepFingerprint();
        if (fp && fp !== fingerprint && decideStep(d).kind !== 'blocked') {
          trace('you moved past the step; taking over again');
          await step();
        }
      }
    }
    if (!this.stopRequested) {
      trace(`gave up after 15 minutes: ${label}`);
      await this.discard(applyDialog());
    }
    return false;
  }

  /** Close the dialog without sending; LinkedIn asks to save or discard, we discard. */
  private async discard(d: Element | null) {
    if (!d) return;
    const x = [...d.querySelectorAll<HTMLElement>('button')].find((b) => /^dismiss|^close/i.test(b.getAttribute('aria-label') || ''));
    if (x) humanClick(x);
    await sleep(800);
    const confirm = applyDialog();
    const discardBtn = confirm && [...confirm.querySelectorAll<HTMLElement>('button')].find((b) => /^discard$/i.test((b.textContent || '').trim()));
    if (discardBtn) humanClick(discardBtn);
    await this.until(() => !applyDialog(), 4000);
  }

  /** Which step the dialog is on: its field names and its buttons. */
  private stepFingerprint(): string {
    const d = applyDialog();
    if (!d) return '';
    const names = [...d.querySelectorAll('input,select,textarea')].map((e) => (e as HTMLInputElement).name || e.id).join(',');
    const btns = [...d.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).join(',');
    return names + '#' + btns;
  }
}
