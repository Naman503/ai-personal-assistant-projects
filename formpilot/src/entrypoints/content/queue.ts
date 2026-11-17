/**
 * Apply queue (LinkedIn): go down the job list, open each Easy Apply job you haven't applied
 * to, fill it and press Next to the Submit button, then wait for YOU to press Submit. After the
 * application is sent, close LinkedIn's confirmation, pause a few seconds and open the next.
 * It presses Submit only with "Apply queue: submit for me" on (off by default), after a
 * cancellable countdown, and only when no step was left for you. A step that needs you (a blank required field, an error) waits;
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
  upsellDecline,
  titleRelevant,
  type JobCard,
} from '@/lib/queue';
import { decideStep, settled } from '@/lib/walk';
import { AI_BLOCKING } from '@/lib/autopilot';
import { dialogAnchor, openDialogs } from '@/lib/fields/context';
import { createLogger } from '@/lib/logger';
import { quietFocus } from '@/lib/automation';
import type { WalkOutcome } from './walk';

const log = createLogger('content:queue');

/**
 * Log a queue step and send it to Options → Logs too (content-script info logs normally stay
 * in the page console), so a run that went wrong can be read back afterwards.
 */
/** The last step written to the log: why a job was skipped, for the autopilot's history. */
let lastTrace = '';

function trace(msg: string, data?: unknown) {
  lastTrace = msg;
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
  /** Press Submit after a short countdown once the walk reaches it with nothing left for you. */
  autoSubmit?: boolean;
  /** Autopilot: stop after this many jobs reached Submit (sent or, in a dry run, "would apply"). */
  batch?: number;
  /** Autopilot dry run: fill to Submit, record "would apply", close without sending. */
  dryRun?: boolean;
  /** Autopilot: nobody is watching, so a job that needs you is skipped instead of waited for. */
  unattended?: boolean;
  /** Autopilot: only jobs whose title shares a distinctive word with these (react, native, mobile…). */
  relevant?: string[];
  /** Autopilot: pause between jobs, seconds [min, max]. */
  pauseSec?: [number, number];
  /** Autopilot: jobs (cardKey) already skipped today, not opened again. */
  seen?: string[];
}

/** What one queue run did (sent back to the autopilot). */
export interface QueueResult {
  sent: number;
  dry: number;
  skipped: number;
  reason: string;
  /** LinkedIn pushed back (limit, checkpoint, login): the autopilot stops. */
  pushback?: string;
  /** The AI couldn't answer (rate limit, quota used up, key…): the autopilot waits, nothing was skipped. */
  aiError?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A visible "Discard" button in any open dialog. */
function discardButton(): HTMLElement | null {
  for (const d of openDialogs()) {
    const b = [...d.querySelectorAll<HTMLElement>('button')].find((x) => /^(discard|don.t save)$/i.test((x.textContent || '').trim()));
    if (b) return b;
  }
  return null;
}

export class ApplyQueue {
  private running = false;
  private stopRequested = false;
  private skipRequested = false;
  /** "Skip the pause": end the current wait between jobs now. */
  private goNow = false;
  private tried = new Set<string>();
  /** LinkedIn pushed back mid-batch (daily Easy Apply limit, security check). */
  private pushback = '';
  private sent = 0;
  /** Sent since the last break; a longer pause comes after a handful, like a person would take. */
  private sinceBreak = 0;
  private breakAfter = 0;
  private dry = 0;
  private skipped = 0;
  private overrides: Partial<QueuePrefs> = {};
  private aiError: string | null = null;
  private result: QueueResult | null = null;

  constructor(
    private deps: {
      prefs: () => QueuePrefs;
      fill: (anchor: HTMLElement) => Promise<{ filled: number; total: number; error?: string }>;
      /** An AI error from any fill during this job (the walker fills later steps too). */
      aiError?: () => string | null;
      walk: (anchor: HTMLElement) => Promise<WalkOutcome>;
      blockedReason: () => string;
      toast: Toast;
      /** Dry run: record "would apply" with the answers on the open form. */
      dryRecord?: (dialog: Element | null) => Promise<void>;
      /** Sent (LinkedIn closed the dialog after Submit): record it in the tracker. */
      recordSent?: () => Promise<void>;
    },
  ) {}

  get active() {
    return this.running;
  }

  stop() {
    this.stopRequested = true;
  }

  /** End the pause between jobs now (from the popup or the autopilot page). */
  skipPause() {
    this.goNow = true;
  }

  /** The prefs for this run: settings plus what the autopilot asked for. */
  private prefs(): QueuePrefs {
    return { ...this.deps.prefs(), ...this.overrides };
  }

  async start(overrides: Partial<QueuePrefs> = {}): Promise<QueueResult | null> {
    if (this.running) {
      this.status('The apply queue is already running.', 'info');
      return null;
    }
    this.overrides = overrides;
    this.result = null;
    this.aiError = null;
    this.dry = 0;
    this.skipped = 0;
    this.running = true;
    this.stopRequested = false;
    this.sent = 0;
    this.pushback = '';
    this.sinceBreak = 0;
    this.breakAfter = 6 + Math.floor(Math.random() * 5);
    try {
      await this.loop();
    } catch (e) {
      log.warn('queue failed', e);
      this.deps.toast(`Apply queue stopped: ${(e as Error).message}`, 'error', undefined, 15_000);
      this.result = { sent: this.sent, dry: this.dry, skipped: this.skipped, reason: `error: ${(e as Error).message}` };
    } finally {
      this.running = false;
    }
    return this.result ?? { sent: this.sent, dry: this.dry, skipped: this.skipped, reason: 'stopped' };
  }

  private bar(): Action[] {
    return [
      { label: 'Skip', run: () => (this.skipRequested = true) },
      { label: 'Stop', run: () => this.stop() },
    ];
  }

  private status(text: string, tone: 'info' | 'success' | 'error' = 'info', ms = 10 * 60_000) {
    this.deps.toast(text, tone, this.running ? this.bar() : undefined, ms);
    // The autopilot shows this live in the popup and its page.
    if (this.overrides.unattended) chrome.runtime.sendMessage({ type: 'autopilot-progress', text }).catch(() => {});
  }

  private async countToday(add = 0): Promise<number> {
    const t = today();
    const got = (await chrome.storage.local.get(DAY_KEY))[DAY_KEY] as { date: string; n: number } | undefined;
    const n = (got?.date === t ? got.n : 0) + add;
    if (add) await chrome.storage.local.set({ [DAY_KEY]: { date: t, n } });
    return n;
  }

  private async loop() {
    const prefs = this.prefs();
    for (const k of prefs.seen ?? []) this.tried.add(k);
    trace(`queue started on ${location.pathname}`, { cap: prefs.cap, delaySec: prefs.delaySec, skip: prefs.skipTitles, autoSubmit: !!prefs.autoSubmit, batch: prefs.batch ?? null, dryRun: !!prefs.dryRun, unattended: !!prefs.unattended });
    for (let page = 0; page < 10 && !this.stopRequested; page++) {
      await this.loadWholeList();
      let list = candidates(jobCards(), prefs.skipTitles, this.tried, prefs.relevant);
      const all = jobCards();
      if (prefs.relevant?.length) {
        const off = all.filter((c) => c.easyApply && !c.applied && !titleRelevant(c.title, prefs.relevant!)).map((c) => c.title);
        if (off.length) trace(`not your kind of job, skipped: ${off.join('; ')}`);
      }
      trace(`page ${page + 1}: ${all.length} cards, ${list.length} to open`, all.map((c) => `${c.applied ? 'A' : '-'}${c.easyApply ? 'E' : '-'} ${c.title} · ${c.company}`));
      if (!all.length && page === 0) return this.finish('No job list found on this page. Open a LinkedIn job search first.');
      while (list.length && !this.stopRequested) {
        const push = pushbackNotice();
        if (push) return this.finish(`${push}. Stopped for today so your account stays safe.`, 'error', push);
        if (prefs.batch && this.sent + this.dry >= prefs.batch) return this.finish(`Batch done: ${this.sent} sent${prefs.dryRun ? `, ${this.dry} would apply (dry run)` : ''}.`);
        if (!prefs.dryRun && (await this.countToday()) >= prefs.cap) return this.finish(`Daily limit reached (${prefs.cap}). Change it in FormPilot settings → Behavior.`);
        const card = list[0];
        this.tried.add(cardKey(card));
        const dryBefore = this.dry;
        const sent = await this.one(card, prefs);
        if (this.pushback) return this.finish(`${this.pushback}. Stopped for today so your account stays safe.`, 'error', this.pushback);
        if (!sent && this.dry === dryBefore && !this.aiError) {
          this.skipped++;
          if (prefs.unattended && !this.stopRequested) {
            const job = `${card.title}${card.company ? ` · ${card.company}` : ''}`;
            const why = lastTrace.replace(/^(skip|skipped)[^:]*:\s*/i, '').replace(job, 'it').slice(0, 200);
            chrome.runtime.sendMessage({ type: 'autopilot-skip', job, reason: why, key: cardKey(card) }).catch(() => {});
          }
        }
        if (this.stopRequested) break;
        if (sent && ++this.sinceBreak >= this.breakAfter) {
          await this.rest(between(60, 150));
          this.sinceBreak = 0;
          this.breakAfter = 6 + Math.floor(Math.random() * 5);
        } else if (prefs.pauseSec && (sent || this.dry > dryBefore)) {
          // Autopilot: a person-like pause after each job that reached Submit.
          const ms = between(prefs.pauseSec[0], prefs.pauseSec[1]);
          const until = Date.now() + ms;
          this.status(`Pause before the next job · ${Math.round(ms / 1000)} s (${this.sent + this.dry} of ${prefs.batch ?? '?'} in this batch)`);
          this.goNow = false;
          await this.until(() => Date.now() >= until || this.goNow, ms, 500);
        } else await this.pause(sent ? jitter(Math.max(prefs.delaySec, 4)) : between(2, 4));
        list = candidates(jobCards(), prefs.skipTitles, this.tried, prefs.relevant);
        if (!list.length) {
          await this.loadWholeList();
          list = candidates(jobCards(), prefs.skipTitles, this.tried, prefs.relevant);
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
    if (this.aiError) return this.finish(`Paused: the AI isn't answering (${this.aiError}). ${this.sent} sent this run.`, 'error', undefined, this.aiError);
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

  private finish(msg: string, tone: 'success' | 'error' = 'success', pushback?: string, aiError?: string) {
    trace(`queue finished: ${msg}`, { sent: this.sent, dry: this.dry, skipped: this.skipped });
    this.result = { sent: this.sent, dry: this.dry, skipped: this.skipped, reason: msg, ...(pushback ? { pushback } : {}), ...(aiError ? { aiError } : {}) };
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
    await this.clearLeftovers();
    // Press Easy Apply; if nothing opens, press it once more (the first press can land mid-render).
    let dialog = false;
    for (let attempt = 0; attempt < 2 && !dialog && !this.stopRequested; attempt++) {
      const b = easyApplyButton();
      if (!b) break;
      quietFocus(8000); // the dialog focuses its first field on open: not a reason to suggest
      humanClick(b);
      dialog = await this.until(() => !!applyDialog() || !!pushbackNotice(), attempt ? 15_000 : 8000);
      if (pushbackNotice()) break; // the daily-limit pop-up: don't press again
    }
    if (this.stopRequested) return false;
    // LinkedIn's "You reached today’s Easy Apply limit" pop-up opens instead of the form: stop the
    // batch here (the autopilot stops LinkedIn for today) rather than trying every job.
    const limit = pushbackNotice();
    if (limit) {
      trace(`pushback after pressing Easy Apply on ${label}: ${limit}`);
      for (const d of openDialogs()) {
        const ok = [...d.querySelectorAll<HTMLElement>('button')].find((b) => /^(got it|dismiss|ok)$/i.test((b.textContent || b.getAttribute('aria-label') || '').trim()));
        if (ok) humanClick(ok);
      }
      this.pushback = limit;
      return false;
    }
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
    this.status(`${prefs.dryRun ? 'Dry run · ' : ''}Filling ${label}`);
    this.deps.aiError?.(); // clear an old one
    await step();
    const ai = this.deps.aiError?.();
    if (ai && AI_BLOCKING.has(ai)) {
      trace(`the AI couldn't answer (${ai}); leaving ${label} for later`);
      await this.discard(applyDialog());
      this.aiError = ai;
      this.stopRequested = true;
      return false;
    }
    if (prefs.dryRun) {
      if (outcome === 'submit') {
        this.dry++;
        trace(`dry run: would apply to ${label}`);
        await this.deps.dryRecord?.(applyDialog()).catch(() => {});
      } else trace(`dry run: skipped ${label} (${outcome === 'blocked' ? this.deps.blockedReason() : outcome})`);
      await this.discard(applyDialog());
      return false;
    }
    if (prefs.unattended && outcome !== 'submit') {
      trace(`skipped (nobody to fill it in): ${label} (${outcome === 'blocked' ? this.deps.blockedReason() : outcome})`);
      await this.discard(applyDialog());
      return false;
    }
    let pressed = false;
    if (outcome === 'submit' && prefs.autoSubmit) pressed = await this.autoSubmit(label, n, prefs);
    // Wait for the user. Up to 15 minutes per job (1 minute when nobody is watching).
    const end = Date.now() + (prefs.unattended ? 60_000 : 15 * 60_000);
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
        // LinkedIn often closes the dialog straight after Submit instead of showing "Application
        // sent". It was sent if Submit was pressed (by us, or by you on the Submit step) and the
        // job now shows its application status.
        const atSubmit = pressed || (outcome as WalkOutcome) === 'submit';
        const applied = atSubmit && (pressed || (await this.until(() => paneShowsApplied(), 8000)));
        if (applied) {
          this.sent++;
          const total = await this.countToday(1);
          trace(`sent: ${label} (${total} today; LinkedIn closed the dialog after Submit)`);
          await this.deps.recordSent?.().catch(() => {});
          this.status(`Sent: ${label}. ${total} of ${prefs.cap} today.`, 'success', 8000);
          return true;
        }
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

  /**
   * Auto-submit (opt-in): a short countdown you can cancel with Skip or Stop, then press the
   * Submit button the walk reached. Only when the walk ended on Submit, so no step was left
   * with an empty required field or an error.
   */
  private async autoSubmit(label: string, n: number, prefs: QueuePrefs): Promise<boolean> {
    const secs = Math.round(between(5, 9) / 1000); // between() is in ms
    const before = this.stepFingerprint();
    for (let s = secs; s > 0; s--) {
      if (this.stopRequested || this.skipRequested) return (trace(`auto-submit cancelled: ${label}`), false);
      if (this.stepFingerprint() !== before) return (trace(`auto-submit cancelled (the form changed): ${label}`), false);
      this.status(`${n} of ${prefs.cap} today · ${label} — Submitting in ${s} s. Press Skip or Stop to cancel.`, 'success');
      await sleep(1000);
    }
    if (this.stopRequested || this.skipRequested) return (trace(`auto-submit cancelled: ${label}`), false);
    const d = applyDialog();
    const step = d ? decideStep(d) : null;
    if (!d || step?.kind !== 'submit' || !/\b(submit|send application|apply)\b/i.test(step.button.textContent ?? '')) return (trace(`auto-submit: no Submit button any more on ${label}`), false);
    trace(`auto-submit: pressing "${(step.button.textContent ?? '').trim()}" for ${label}`);
    humanClick(step.button);
    return true;
  }

  /** Close the dialog without sending; LinkedIn asks to save or discard, we discard. */
  private async discard(d: Element | null) {
    if (!d) return;
    const x = [...d.querySelectorAll<HTMLElement>('button')].find((b) => /^dismiss|^close/i.test(b.getAttribute('aria-label') || ''));
    if (x) humanClick(x);
    await sleep(800);
    // LinkedIn then asks "Save this application?" in a second dialog (no form in it, so
    // applyDialog() doesn't see it). Left open, it covers the page and every later Easy Apply
    // press does nothing (live, 17 Nov). Press Discard wherever it is.
    await this.pressDiscard();
    await this.until(() => !applyDialog() && !discardButton(), 4000);
  }

  /** "Discard" in any open dialog (LinkedIn's "Save this application?"). */
  private async pressDiscard(): Promise<boolean> {
    const b = discardButton();
    if (!b) return false;
    humanClick(b);
    await sleep(600);
    return true;
  }

  /** Before opening a job: close whatever an earlier job (or you) left open. */
  private async clearLeftovers() {
    if (await this.pressDiscard()) trace('closed a leftover "Save this application?" dialog');
    // "Not now" on pop-ups that block the list (profile / Premium offers after a send).
    for (const d of openDialogs()) {
      if (applyDialog() === d && !isSentDialog(d)) continue;
      const b = upsellDecline(d);
      if (!b) continue;
      trace(`closed a pop-up over the job list with "${(b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 30)}": ${(d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`);
      humanClick(b);
      await sleep(600);
    }
    const d = applyDialog();
    if (d && !isSentDialog(d)) {
      trace('closing a leftover application dialog');
      await this.discard(d);
    } else if (d && isSentDialog(d)) {
      const close = closeButton(d);
      if (close) humanClick(close);
      await sleep(600);
    }
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
