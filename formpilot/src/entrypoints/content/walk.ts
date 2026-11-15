/**
 * "Walk to Submit": after a whole-form fill on a multi-step application (LinkedIn Easy Apply
 * and the like), press Next/Review for the user, fill the next step, and stop at the Submit
 * button, highlighted. It never presses Submit, and it stops the moment a step needs the user.
 */
import { decideStep, firstEmptyField, settled, stepScope } from '@/lib/walk';
import { createLogger } from '@/lib/logger';

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
      for (let step = 0; step < MAX_STEPS; step++) {
        const d = decideStep(scope);
        if (d.kind === 'blocked') {
          log.info(`walk stopped: ${d.reason}`);
          d.field?.focus?.({ preventScroll: false });
          d.field?.scrollIntoView?.({ block: 'center' });
          toast(`${d.reason}. Fill it in, then press Next yourself.`, 'info', undefined, 8000);
          this.lastReason = d.reason;
          return 'blocked';
        }
        if (d.kind === 'submit') {
          this.highlight(d.button);
          d.button.scrollIntoView?.({ block: 'center' });
          toast('Ready to submit. Check the answers, then press the highlighted button.', 'success', undefined, 20_000);
          return 'submit';
        }
        if (d.kind === 'none') {
          log.debug('walk: no Next or Submit button on this step');
          return 'none';
        }
        // Next step: keep the answers of this step for the tracker, move on, fill what appears.
        this.deps.collect(scope);
        log.info(`walk: pressing "${d.button.textContent?.trim()}" (step ${step + 1})`);
        d.button.click();
        await settled(scope.getRootNode(), 450, 4000);
        if (!scope.isConnected) scope = stepScope(anchor.isConnected ? anchor : document.body);
        const next = firstEmptyField(scope);
        if (next) {
          const r = await this.deps.fill(next);
          log.debug(`walk: filled ${r.filled}/${r.total} on the new step`);
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
