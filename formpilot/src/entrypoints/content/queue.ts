/**
 * Apply queue (LinkedIn): go down the job list, open each Easy Apply job you haven't applied
 * to, fill it and press Next to the Submit button, then wait for YOU to press Submit. After the
 * application is sent, close LinkedIn's confirmation, pause a few seconds and open the next.
 * It never presses Submit. A step that needs you (a blank required field, an error) waits;
 * once you move past it, the queue takes over again.
 */
import { applyDialog, candidates, cardKey, closeButton, currentJobId, easyApplyButton, isSentDialog, jitter, jobCards, nextPageButton, paneShowsApplied, paneShowsTitle, today, type JobCard } from '@/lib/queue';
import { decideStep, settled } from '@/lib/walk';
import { dialogAnchor } from '@/lib/fields/context';
import { createLogger } from '@/lib/logger';
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
      let list = candidates(jobCards(), prefs.skipTitles, this.tried);
      const all = jobCards();
      trace(`page ${page + 1}: ${all.length} cards, ${list.length} to open`, all.map((c) => `${c.applied ? 'A' : '-'}${c.easyApply ? 'E' : '-'} ${c.title} · ${c.company}`));
      if (!list.length && page === 0) {
        const all = jobCards();
        if (!all.length) return this.finish("No job list found on this page. Open a LinkedIn job search first.");
      }
      while (list.length && !this.stopRequested) {
        if ((await this.countToday()) >= prefs.cap) return this.finish(`Daily limit reached (${prefs.cap}). Change it in FormPilot settings → Behavior.`);
        const card = list[0];
        this.tried.add(cardKey(card));
        await this.one(card, prefs);
        if (this.stopRequested) break;
        await sleep(jitter(prefs.delaySec));
        list = candidates(jobCards(), prefs.skipTitles, this.tried);
      }
      if (this.stopRequested) break;
      const next = nextPageButton();
      if (!next) break;
      const firstBefore = jobCards()[0]?.title;
      this.status('Opening the next page of jobs…');
      next.click();
      await this.until(() => (jobCards()[0]?.title ?? '') !== firstBefore, 15_000);
      await sleep(1500);
    }
    this.finish(this.stopRequested ? `Apply queue stopped. ${this.sent} sent this run.` : `Done with this list. ${this.sent} sent this run.`);
  }

  private finish(msg: string) {
    trace(`queue finished: ${msg}`);
    this.running = false;
    this.deps.toast(msg, 'success', undefined, 12_000);
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

  /** One job: open it, Easy Apply, fill to Submit, wait for the user. */
  private async one(card: JobCard, prefs: QueuePrefs) {
    this.skipRequested = false;
    const label = `${card.title}${card.company ? ` · ${card.company}` : ''}`;
    const n = (await this.countToday()) + 1;
    this.status(`${n} of ${prefs.cap} today · Opening ${label}`);
    card.el.scrollIntoView({ block: 'center' });
    await sleep(400);
    const before = { id: currentJobId(location.href), btn: easyApplyButton() };
    trace(`opening: ${label}`, { from: before.id });
    card.el.click();
    // The job pane takes a few seconds and keeps the old job's Easy Apply button until the new
    // job loads: wait for the job id to change and the pane to show this job's title.
    const loaded = () => (currentJobId(location.href) !== before.id || !before.btn?.isConnected) && paneShowsTitle(card.title) && (!!easyApplyButton() || paneShowsApplied());
    if (!(await this.until(loaded, 25_000))) {
      trace(`skip: the job pane didn't load ${label} within 25 s`, { id: currentJobId(location.href), title: paneShowsTitle(card.title), easy: !!easyApplyButton() });
      return;
    }
    if (!easyApplyButton()) {
      trace(`skip: no Easy Apply button for ${label} (already applied or external)`);
      return;
    }
    const jobId = currentJobId(location.href);
    await sleep(600 + Math.random() * 600);
    easyApplyButton()!.click();
    if (!(await this.until(() => !!applyDialog(), 15_000))) {
      trace(`skip: the Easy Apply dialog didn't open for ${label}`);
      return;
    }
    // Safety: the dialog must be for this company ("Apply to <Company>").
    const head = (applyDialog()?.textContent || '').replace(/\s+/g, ' ');
    if (card.company && /apply to /i.test(head) && !head.toLowerCase().includes(card.company.toLowerCase().slice(0, 12))) {
      trace(`skip: the dialog is for a different company than ${label}`, head.slice(0, 120));
      await this.discard(applyDialog());
      return;
    }
    trace(`dialog open for ${label}`, { jobId, url: location.pathname });
    await settled(document, 400, 2500);
    await this.drive(label, n, prefs);
  }

  /** Fill and walk the open dialog; then wait for the user to submit, skip or close it. */
  private async drive(label: string, n: number, prefs: QueuePrefs) {
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
        close?.click();
        await this.until(() => !isSentDialog(applyDialog()), 5000);
        return;
      }
      if (!d) {
        trace(`dialog closed without sending: ${label}`);
        return; // the user closed or discarded it
      }
      if (this.skipRequested) {
        trace(`skipped by you: ${label}`);
        await this.discard(d);
        return;
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
  }

  /** Close the dialog without sending; LinkedIn asks to save or discard, we discard. */
  private async discard(d: Element | null) {
    if (!d) return;
    const x = [...d.querySelectorAll<HTMLElement>('button')].find((b) => /^dismiss|^close/i.test(b.getAttribute('aria-label') || ''));
    x?.click();
    await sleep(800);
    const confirm = applyDialog();
    const discardBtn = confirm && [...confirm.querySelectorAll<HTMLElement>('button')].find((b) => /^discard$/i.test((b.textContent || '').trim()));
    discardBtn?.click();
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
