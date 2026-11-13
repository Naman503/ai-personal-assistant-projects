/**
 * Job tracker: notice when an application goes through and record it.
 *
 * A click on a Submit/Apply-style button "arms" the watcher for 30 seconds. While armed it
 * looks for the site's confirmation ("Your application was sent", "Thank you for applying")
 * in newly added text, or a redirect to a thank-you page. Answers are collected as you go,
 * including on earlier steps of multi-page forms (Next / Continue / Review clicks), because
 * those steps are gone from the page by the time you submit.
 */
import { CONFIRMATION_URL_RE, extractJob, isConfirmation, looksLikeSubmit, type GivenAnswer, type JobInfo } from '@/lib/job';
import { extractField, fieldKind, isVisible, readValue, type FillableElement } from '@/lib/fields/context';
import { isSensitive } from '@/lib/fields/classify';
import { rpc } from '@/lib/messages';
import { createLogger } from '@/lib/logger';
import { truncate } from '@/lib/util';

const log = createLogger('content:tracker');
const ARM_MS = 30_000;
const SESSION_MS = 30 * 60_000;
const STEP_RE = /^(next|continue|review|save (and|&) continue|proceed)\b/i;

type Toast = (text: string, tone: 'info' | 'success' | 'error', action?: { label: string; run: () => void }) => void;

export interface TrackerPrefs {
  on: boolean;
  autoRecord: boolean;
  includeAnswers: boolean;
}

export class ApplyWatcher {
  private armedUntil = 0;
  private job: JobInfo | null = null;
  private answers = new Map<string, string>();
  private sessionStart = 0;
  private recorded = new Set<string>();
  private observer: MutationObserver | null = null;
  private tick: ReturnType<typeof setInterval> | undefined;
  private startUrl = '';

  constructor(
    private prefs: () => TrackerPrefs,
    private toast: Toast,
  ) {}

  /** Capture-phase click anywhere on the page. */
  onClick(target: EventTarget | null) {
    const p = this.prefs();
    if (!p.on || !p.autoRecord || !(target instanceof Element)) return;
    const btn = target.closest('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]');
    if (!btn) return;
    const text = ((btn as HTMLInputElement).value || btn.textContent || btn.getAttribute('aria-label') || '').trim();
    const scope = btn.closest('form, [role="dialog"], [aria-modal="true"]') ?? document.body;
    if (STEP_RE.test(text)) return this.collect(scope);
    if (looksLikeSubmit(text)) this.arm(scope);
  }

  /** A native form submit (Enter in a field, or a submit button). */
  onSubmit(form: EventTarget | null) {
    const p = this.prefs();
    if (!p.on || !p.autoRecord) return;
    this.arm(form instanceof Element ? form : document.body);
  }

  private collect(scope: Element) {
    if (!this.prefs().includeAnswers) return;
    if (Date.now() - this.sessionStart > SESSION_MS) this.answers.clear();
    if (!this.answers.size) this.sessionStart = Date.now();
    for (const el of scope.querySelectorAll<HTMLElement>('input, textarea, select, [contenteditable="true"]')) {
      if (this.answers.size >= 60) break;
      if (!fieldKind(el) || !isVisible(el)) continue;
      const input = el as HTMLInputElement;
      if (input.type === 'radio' && !input.checked) continue;
      if (input.type === 'checkbox' || input.type === 'file' || input.type === 'hidden' || input.type === 'password') continue;
      const f = extractField(el as FillableElement);
      if (!f || isSensitive(f.semantic)) continue;
      const q = (f.label || f.placeholder || '').trim();
      // Skip fields without a real question ("input_23", bare numbers).
      if (!q || q.length < 3 || /^[\d\s_-]+$/.test(q)) continue;
      const a = (input.type === 'radio' ? (input.labels?.[0]?.textContent ?? input.value) : readValue(el as FillableElement)).trim();
      if (!a || a.toLowerCase() === 'select an option') continue;
      this.answers.set(truncate(q, 200), truncate(a, 600));
    }
  }

  private arm(scope: Element) {
    this.collect(scope);
    const job = extractJob();
    // Keep the job we saw first if this step of the page no longer shows it.
    if (!this.job || (job.role && job.company)) this.job = job;
    this.armedUntil = Date.now() + ARM_MS;
    this.startUrl = location.href;
    log.debug('armed: watching for an application confirmation', { role: this.job.role, company: this.job.company });
    if (this.observer) return;
    this.observer = new MutationObserver((muts) => {
      if (Date.now() > this.armedUntil) return this.disarm();
      let added = '';
      for (const m of muts) {
        for (const n of m.addedNodes) {
          added += ' ' + (n.textContent ?? '');
          if (added.length > 4000) break;
        }
        if (m.type === 'characterData') added += ' ' + (m.target.textContent ?? '');
      }
      if (added.trim() && isConfirmation(added)) this.confirmed('message');
    });
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    this.tick = setInterval(() => {
      if (Date.now() > this.armedUntil) return this.disarm();
      if (location.href !== this.startUrl && CONFIRMATION_URL_RE.test(new URL(location.href).pathname)) this.confirmed('redirect');
    }, 1000);
  }

  private disarm() {
    this.observer?.disconnect();
    this.observer = null;
    clearInterval(this.tick);
    this.armedUntil = 0;
  }

  private confirmed(how: string) {
    this.disarm();
    const job = this.job ?? extractJob();
    void this.record(job, 'applied', how);
  }

  /** Save the job on this page (toolbar / right-click) without marking it applied. */
  saveCurrent() {
    return this.record(extractJob(), 'saved', 'manual');
  }

  /** "I applied" from the toolbar, for sites whose confirmation FormPilot can't see. */
  markApplied() {
    this.collect(document.body);
    return this.record(this.job ?? extractJob(), 'applied', 'manual');
  }

  private async record(job: JobInfo, kind: 'applied' | 'saved', how: string) {
    const key = `${kind}:${job.url}`;
    if (this.recorded.has(key)) return;
    this.recorded.add(key);
    const answers: GivenAnswer[] = kind === 'applied' && this.prefs().includeAnswers ? [...this.answers].map(([q, a]) => ({ q, a })) : [];
    log.info(`recording ${kind} (${how}): ${job.role} at ${job.company}`);
    try {
      const r = await rpc<{ created: boolean; status: string }>({ type: 'tracker-record', kind, job, answers });
      const what = `${truncate(job.role || 'Job', 50)}${job.company ? ` at ${truncate(job.company, 40)}` : ''}`;
      this.toast(kind === 'applied' ? `Recorded in your job tracker: ${what}` : r.created ? `Saved to your job tracker: ${what}` : `Already in your job tracker: ${what}`, 'success');
      if (kind === 'applied') {
        this.answers.clear();
        this.job = null;
      }
    } catch (e) {
      this.recorded.delete(key);
      log.warn('could not record in the job tracker', e);
      this.toast(`Couldn't reach your job tracker: ${(e as Error).message}`, 'error', { label: 'Try again', run: () => void this.record(job, kind, how) });
    }
  }
}
