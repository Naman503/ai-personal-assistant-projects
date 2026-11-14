/**
 * Walking a multi-step application form: after a fill, decide whether the current step can
 * move on (Next / Review), has reached the Submit button, or needs the user first.
 * Pure DOM reading, content-script safe. The walker never presses Submit.
 */
import { fieldKind, isVisible, readValue, type FillableElement } from '@/lib/fields/context';
import { looksLikeSubmit } from '@/lib/job';

/** Buttons that move to the next step of a form without sending it. */
export const STEP_RE = /^(next|continue|review|save (and|&) continue|proceed)\b/i;

export type WalkDecision =
  | { kind: 'submit'; button: HTMLElement }
  | { kind: 'next'; button: HTMLElement }
  | { kind: 'blocked'; reason: string; field?: HTMLElement }
  | { kind: 'none' };

const BUTTONS = 'button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]';

export function buttonText(btn: Element): string {
  return ((btn as HTMLInputElement).value || btn.textContent || btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
}

function enabled(btn: Element): boolean {
  return !(btn as HTMLButtonElement).disabled && btn.getAttribute('aria-disabled') !== 'true' && isVisible(btn as HTMLElement);
}

/** Required fields on this step that are still empty (checkboxes and files are left to the user). */
export function emptyRequired(scope: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const seenRadio = new Set<string>();
  for (const el of scope.querySelectorAll<HTMLElement>('input, textarea, select, [contenteditable="true"]')) {
    const input = el as HTMLInputElement;
    if (!isVisible(el) || (input.type !== 'radio' && !fieldKind(el))) continue;
    const required = input.required || el.getAttribute('aria-required') === 'true';
    if (!required) continue;
    if (input.type === 'checkbox' || input.type === 'file' || input.type === 'hidden') continue;
    if (input.type === 'radio') {
      const k = input.name || input.id;
      if (seenRadio.has(k)) continue;
      seenRadio.add(k);
      const group = [...scope.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(input.name)}"]`)];
      if (!group.some((r) => r.checked)) out.push(el);
      continue;
    }
    const v = readValue(el as FillableElement).trim();
    if (!v || (el instanceof HTMLSelectElement && el.selectedIndex <= 0 && !v)) out.push(el);
  }
  return out;
}

/** A visible validation error on this step, if any. */
export function visibleError(scope: Element): HTMLElement | null {
  for (const el of scope.querySelectorAll<HTMLElement>('[aria-invalid="true"], [role="alert"], [class*="error"], [class*="invalid"]')) {
    if (!isVisible(el)) continue;
    if (el.getAttribute('aria-invalid') === 'true') return el;
    // Error containers only count when they actually say something.
    if ((el.textContent ?? '').trim().length > 2 && /error|invalid|required|must|please|enter/i.test(el.textContent ?? '')) return el;
  }
  return null;
}

/** What to do after filling the current step. */
export function decideStep(scope: Element): WalkDecision {
  const buttons = [...scope.querySelectorAll<HTMLElement>(BUTTONS)].filter(enabled);
  const submit = buttons.find((b) => !STEP_RE.test(buttonText(b)) && looksLikeSubmit(buttonText(b)));
  const next = buttons.find((b) => STEP_RE.test(buttonText(b)));
  const err = visibleError(scope);
  if (err) return { kind: 'blocked', reason: 'There is an error on this step', field: err };
  const missing = emptyRequired(scope);
  if (missing.length) return { kind: 'blocked', reason: `${missing.length} required field${missing.length > 1 ? 's' : ''} need${missing.length > 1 ? '' : 's'} you`, field: missing[0] };
  if (submit) return { kind: 'submit', button: submit };
  if (next) return { kind: 'next', button: next };
  return { kind: 'none' };
}

/** The dialog or form that holds this element, across shadow boundaries. */
export function stepScope(el: Element): Element {
  let cur: Element | null = el;
  while (cur) {
    const hit = cur.closest('[role="dialog"], [aria-modal="true"], form');
    if (hit) return hit;
    const root = cur.getRootNode();
    cur = root instanceof ShadowRoot ? root.host : null;
  }
  return el.ownerDocument.body;
}

/** First empty, visible, fillable field in a scope (where the next fill should anchor). */
export function firstEmptyField(scope: Element): HTMLElement | null {
  for (const el of scope.querySelectorAll<HTMLElement>('input, textarea, select, [contenteditable="true"]')) {
    const input = el as HTMLInputElement;
    if (!isVisible(el) || (input.type !== 'radio' && !fieldKind(el))) continue;
    if (['checkbox', 'file', 'hidden', 'password', 'submit', 'button'].includes(input.type)) continue;
    if (input.type === 'radio') return el;
    if (!readValue(el as FillableElement).trim()) return el;
  }
  return null;
}

/** Resolve once the DOM has been quiet for `quiet` ms, or after `max` ms. */
export function settled(root: Node, quiet = 400, max = 3000): Promise<void> {
  return new Promise((resolve) => {
    let t = setTimeout(done, quiet);
    const stop = setTimeout(done, max);
    const mo = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(done, quiet);
    });
    function done() {
      clearTimeout(t);
      clearTimeout(stop);
      mo.disconnect();
      resolve();
    }
    mo.observe(root, { childList: true, subtree: true, attributes: true });
  });
}
