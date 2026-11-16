/**
 * "Walk to Submit": after a whole-form fill on a multi-step application (LinkedIn Easy Apply
 * and the like), press Next/Review for the user, fill the next step, and stop at the Submit
 * button, highlighted. It never presses Submit, and it stops the moment a step needs the user.
 */
import { decideStep, fieldErrors, firstEmptyField, settled, stepFingerprint, stepScope, type FieldError } from '@/lib/walk';
import { createLogger } from '@/lib/logger';
import { quietFocus } from '@/lib/automation';
import { fillElement } from '@/lib/fields/fill';
import { repairValue, specOf } from '@/lib/fields/adapt';
import { readValue, type FillableElement } from '@/lib/fields/context';

const log = createLogger('content:walk');
const MAX_STEPS = 12;

type Toast = (text: string, tone: 'info' | 'success' | 'error', action?: { label: string; run: () => void }, ms?: number) => void;

export type WalkOutcome = 'submit' | 'blocked' | 'none' | 'error' | 'busy';

export class ApplyWalker {
  private running = false;
  /** Why the last walk stopped on a step (for the queue's status line). */
  lastReason = '';
  private highlighted: { el: HTMLElement; outline: string; offset: string } | null = null;

  constructor(
    private deps: {
      fill: (anchor: HTMLElement) => Promise<{ filled: number; total: number }>;
      collect: (scope: Element) => void;
      toast: Toast;
      accent: () => string;
    },
  ) {}

  /**
   * Start from the field the fill was anchored on. Resolves with where the walk stopped:
   * at Submit, on a step that needs the user, or nowhere useful. `silent` leaves the
   * messages to the caller (the apply queue shows its own).
   */
  async run(anchor: HTMLElement, opts: { silent?: boolean } = {}): Promise<WalkOutcome> {
    if (this.running) return 'busy';
    const toast: Toast = (...a) => { if (!opts.silent) this.deps.toast(...a); };
    this.running = true;
    this.clearHighlight();
    try {
      let scope = stepScope(anchor);
      const tries = new WeakMap<HTMLElement, number>();
      let repaired = false;
      let stuck = 0;
      for (let step = 0; step < MAX_STEPS; step++) {
        // A field the site rejected ("Invalid input", "Enter a whole number between 0 and 99"):
        // fix the value ourselves first; only ask the user when no fix fits.
        const errs = fieldErrors(scope).filter((e) => e.shown);
        if (errs.length) {
          log.info(`walk: ${errs.length} field error(s) on this step`, errs.map((e) => `${e.label}: "${e.msg}" (value ${JSON.stringify(readValue(e.field as FillableElement))})`));
          const fixed = this.repair(errs, tries);
          if (fixed) {
            repaired = true;
            await settled(scope.getRootNode(), 300, 1500);
          }
        }
        const d = decideStep(scope, { ignoreErrors: repaired });
        repaired = false;
        if (d.kind === 'blocked') {
          log.info(`walk stopped: ${d.reason}`);
          quietFocus();
          d.field?.focus?.({ preventScroll: false });
          d.field?.scrollIntoView?.({ block: 'center' });
          toast(`${d.reason}. Fix it, then press Next yourself.`, 'info', undefined, 8000);
          this.lastReason = d.reason;
          return 'blocked';
        }
        if (d.kind === 'submit') {
          this.highlight(d.button);
          d.button.scrollIntoView?.({ block: 'center' });
          log.info('walk: reached Submit; waiting for you');
          toast('Ready to submit. Check the answers, then press the highlighted button.', 'success', undefined, 20_000);
          return 'submit';
        }
        if (d.kind === 'none') {
          log.info('walk: no Next or Submit button on this step');
          return 'none';
        }
        // Next step: keep the answers of this step for the tracker, move on, fill what appears.
        this.deps.collect(scope);
        const before = stepFingerprint(scope);
        log.info(`walk: pressing "${d.button.textContent?.trim()}" (step ${step + 1})`);
        quietFocus(4500); // LinkedIn focuses the next step's first field itself
        d.button.click();
        await settled(scope.getRootNode(), 450, 4000);
        if (!scope.isConnected) scope = stepScope(anchor.isConnected ? anchor : document.body);
        if (scope.isConnected && stepFingerprint(scope) === before) {
          // Didn't move on. Errors are handled at the top of the loop; with none to fix twice
          // in a row, something on this step needs the user.
          const left = fieldErrors(scope).filter((e) => e.shown);
          if (!left.length && ++stuck >= 2) {
            this.lastReason = 'Next did not move on; something on this step needs you';
            log.info(`walk stopped: ${this.lastReason}`, (scope.textContent ?? '').replace(/\s+/g, ' ').slice(0, 300));
            toast(`${this.lastReason}.`, 'info', undefined, 8000);
            return 'blocked';
          }
          continue;
        }
        stuck = 0;
        const next = firstEmptyField(scope);
        if (next) {
          const r = await this.deps.fill(next);
          log.info(`walk: filled ${r.filled}/${r.total} on the new step`);
          await settled(scope.getRootNode(), 300, 1500);
        }
      }
      toast('Stopped after many steps. Continue by hand.', 'info');
      return 'none';
    } catch (e) {
      log.warn('walk failed', e);
      toast(`Couldn't continue the form: ${(e as Error).message}`, 'error');
      return 'error';
    } finally {
      this.running = false;
    }
  }

  /** Rewrite rejected values (number only, rescaled to the stated range). Returns how many changed. */
  private repair(errs: FieldError[], tries: WeakMap<HTMLElement, number>): number {
    let n = 0;
    for (const e of errs) {
      const el = e.field as HTMLInputElement;
      if (!(el instanceof HTMLInputElement) || ['radio', 'checkbox'].includes(el.type)) continue;
      const attempt = tries.get(el) ?? 0;
      if (attempt >= 3) continue;
      tries.set(el, attempt + 1);
      const now = el.value;
      const fix = repairValue(now, e.msg, specOf(el, e.label), attempt);
      if (fix === null || fix === now) {
        log.info(`repair: no better value for "${e.label}" (${JSON.stringify(now)}, "${e.msg}")`);
        continue;
      }
      quietFocus();
      const r = fillElement(el, fix, 'replace', e.label, { exact: true });
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      log.info(`repair: "${e.label}" ${JSON.stringify(now)} → ${JSON.stringify(r.value)} after "${e.msg}" (try ${attempt + 1})`);
      if (r.ok) n++;
    }
    return n;
  }

  private highlight(el: HTMLElement) {
    this.clearHighlight();
    this.highlighted = { el, outline: el.style.outline, offset: el.style.outlineOffset };
    el.style.outline = `3px solid ${this.deps.accent()}`;
    el.style.outlineOffset = '2px';
    const clear = () => {
      this.clearHighlight();
      el.removeEventListener('click', clear);
    };
    el.addEventListener('click', clear);
  }

  private clearHighlight() {
    if (!this.highlighted) return;
    const { el, outline, offset } = this.highlighted;
    el.style.outline = outline;
    el.style.outlineOffset = offset;
    this.highlighted = null;
  }
}
