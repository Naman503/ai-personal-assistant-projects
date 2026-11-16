/**
 * Walking a multi-step application form: after a fill, decide whether the current step can
 * move on (Next / Review), has reached the Submit button, or needs the user first.
 * Pure DOM reading, content-script safe. The walker never presses Submit.
 */
import { fieldKind, isVisible, isVisibleControl, readValue, resolveLabel, type FillableElement } from '@/lib/fields/context';
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
    if (!isVisibleControl(el) || (input.type !== 'radio' && !fieldKind(el))) continue;
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

/** Text that reads as a validation message, not a hint or a counter. */
export const ERROR_RE = /\b(invalid|not valid|is required|required field|must be|must have|please (enter|select|provide|choose|answer|fill)|enter (a|an|the|your|valid)\b|should be|larger than|smaller than|greater than|less than|between -?[\d.,]+ and|whole number|decimal number|too (long|short|large|small)|only numbers|numbers only)\b/i;
const COUNTER_RE = /\b\d+\s*\/\s*\d+\b|\b\d+ of \d+ characters?\b/gi;

export interface FieldError {
  field: HTMLElement;
  label: string;
  msg: string;
  /** Shown as an error now (red text, aria-invalid or role=alert), not just a hint. */
  shown: boolean;
}

const reddish = (el: Element) => {
  const m = getComputedStyle(el).color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return !!m && +m[1] > 140 && +m[2] < 100 && +m[3] < 100;
};

/** The validation message element for one field: aria-describedby / aria-errormessage, then nearby text. */
function errorNear(el: HTMLElement): { msg: string; shown: boolean } | null {
  const root = el.getRootNode() as Document | ShadowRoot;
  const ids = `${el.getAttribute('aria-describedby') ?? ''} ${el.getAttribute('aria-errormessage') ?? ''}`.split(/\s+/).filter(Boolean);
  const pools: Element[] = ids.map((id) => root.getElementById?.(id) ?? null).filter((x): x is HTMLElement => !!x);
  // Nearby: the closest ancestors that hold only this field.
  let p = el.parentElement;
  for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
    const controls = [...p.querySelectorAll('input:not([type=hidden]),select,textarea')].filter((c) => (c as HTMLInputElement).type !== 'radio' || (c as HTMLInputElement).name !== (el as HTMLInputElement).name);
    if (controls.length > 1) break;
    pools.push(p);
  }
  for (const pool of pools) {
    const nodes = [pool, ...pool.querySelectorAll<HTMLElement>('p,span,div,small,li,[role="alert"]')].filter((n) => !n.querySelector('input,select,textarea') && isVisible(n as HTMLElement));
    for (const n of nodes) {
      const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ').trim() || (n.children.length ? '' : (n.textContent ?? ''));
      const msg = own.replace(COUNTER_RE, '').replace(/\s+/g, ' ').trim();
      if (msg.length < 4 || msg.length > 200 || !ERROR_RE.test(msg)) continue;
      const shown = reddish(n) || n.getAttribute('role') === 'alert' || el.getAttribute('aria-invalid') === 'true';
      return { msg, shown };
    }
  }
  return el.getAttribute('aria-invalid') === 'true' ? { msg: 'Invalid value', shown: true } : null;
}

/** Fields on this step with a validation message (LinkedIn: a red "Invalid input" under the box). */
export function fieldErrors(scope: Element): FieldError[] {
  const out: FieldError[] = [];
  const seen = new Set<string>();
  for (const el of scope.querySelectorAll<HTMLElement>('input, textarea, select')) {
    const input = el as HTMLInputElement;
    if (['hidden', 'submit', 'button', 'file'].includes(input.type) || !isVisibleControl(el)) continue;
    if (input.type === 'radio' || input.type === 'checkbox') {
      if (seen.has(input.name)) continue;
      seen.add(input.name);
    }
    const e = errorNear(el);
    if (e) out.push({ field: el, label: (el.getAttribute('data-formpilot-need') || resolveLabel(el as FillableElement) || el.getAttribute('aria-label') || input.name || '').slice(0, 120), ...e });
  }
  return out;
}

/** What to do after filling the current step. `ignoreErrors`: messages left from before a repair. */
export function decideStep(scope: Element, opts: { ignoreErrors?: boolean } = {}): WalkDecision {
  const buttons = [...scope.querySelectorAll<HTMLElement>(BUTTONS)].filter(enabled);
  const submit = buttons.find((b) => !STEP_RE.test(buttonText(b)) && looksLikeSubmit(buttonText(b)));
  const next = buttons.find((b) => STEP_RE.test(buttonText(b)));
  if (!opts.ignoreErrors) {
    const fe = fieldErrors(scope).find((e) => e.shown);
    if (fe) return { kind: 'blocked', reason: `"${fe.label || 'A field'}": ${fe.msg}`, field: fe.field };
    const err = visibleError(scope);
    if (err) return { kind: 'blocked', reason: 'There is an error on this step', field: err };
  }
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
    if (!isVisibleControl(el) || (input.type !== 'radio' && !fieldKind(el))) continue;
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

/** Which step a form is on: its field ids and button labels. Unchanged after Next = it didn't move. */
export function stepFingerprint(scope: Element): string {
  const ids = [...scope.querySelectorAll('input,select,textarea')].map((e) => (e as HTMLInputElement).name || e.id).join(',');
  const btns = [...scope.querySelectorAll(BUTTONS)].map((b) => buttonText(b)).join(',');
  return `${ids}#${btns}#${(scope.textContent ?? '').match(/\b\d+\s*\/\s*\d+ pages\b/i)?.[0] ?? ''}`;
}
