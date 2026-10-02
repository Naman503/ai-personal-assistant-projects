/**
 * Insert text into any kind of field in a way frameworks notice.
 *
 * Strategy per kind:
 *  - input/textarea: `execCommand('insertText')`. It goes through the browser's
 *    native editing pipeline, so React/Vue/Angular see a genuine `input` event
 *    and Ctrl+Z still works. If the value didn't take, fall back to the
 *    *prototype* value setter (bypassing React's value tracker) plus synthetic
 *    `input` and `change` events.
 *  - contenteditable (Gmail, LinkedIn, Lexical, ProseMirror, Draft.js):
 *    `execCommand('insertText')` → synthetic `paste` with DataTransfer → textContent.
 *  - select / radio: best-matching option, then `input` and `change`.
 */

import { clampToLength, collapseWs, normalizeText } from '../util';
import { editableRoot, readValue } from './context';
import { createLogger } from '../logger';

const log = createLogger('fill');

export type FillMethod = 'execCommand' | 'setter' | 'paste' | 'textContent' | 'select' | 'radio' | 'checkbox' | 'none';

export interface FillResult {
  ok: boolean;
  method: FillMethod;
  previous: string;
  value: string;
}

const NO_SELECTION_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time', 'number', 'email', 'color', 'range']);

function nativeSetter(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): ((v: string) => void) | null {
  let proto: object | null = Object.getPrototypeOf(el);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) return (v: string) => desc.set!.call(el, v);
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}

function fire(el: Element, type: 'input' | 'change' | 'blur' | 'focusout', data?: string) {
  const ev =
    type === 'input'
      ? new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: data ?? null })
      : type === 'blur'
        ? new FocusEvent('blur', { bubbles: false })
        : type === 'focusout'
          ? new FocusEvent('focusout', { bubbles: true, composed: true })
          : new Event('change', { bubbles: true });
  el.dispatchEvent(ev);
}

/** Normalise a model answer to what the input type accepts (dates → ISO etc.). */
export function coerceForInput(el: HTMLInputElement, text: string): string {
  const t = el.type.toLowerCase();
  const s = text.trim();
  if (t === 'number' || t === 'range') {
    const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? m[0] : '';
  }
  if (t === 'date') {
    const iso = s.match(/\d{4}-\d{2}-\d{2}/);
    if (iso) return iso[0];
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  if (t === 'month') return s.match(/\d{4}-\d{2}/)?.[0] ?? '';
  if (t === 'time') return s.match(/\d{2}:\d{2}/)?.[0] ?? '';
  if (t === 'email') return s.replace(/\s+/g, '');
  if (t === 'tel') return s.replace(/[^\d+()\-\s.]/g, '').trim();
  if (t === 'text' || t === 'search' || t === 'url' || t === '') return s.replace(/\r?\n+/g, ' ');
  return s;
}

function fillTextControl(el: HTMLInputElement | HTMLTextAreaElement, raw: string, mode: 'replace' | 'cursor'): FillResult {
  const previous = el.value;
  const isInput = el instanceof HTMLInputElement;
  let text = isInput ? coerceForInput(el, raw) : raw;
  if (el.maxLength > 0) text = clampToLength(text, el.maxLength);

  let expected = text;
  const canSelect = !isInput || !NO_SELECTION_TYPES.has(el.type.toLowerCase());
  el.focus({ preventScroll: true });

  if (canSelect) {
    try {
      if (mode === 'replace') el.setSelectionRange(0, el.value.length);
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      expected = el.value.slice(0, start) + text + el.value.slice(end);
      if (el.maxLength > 0) expected = expected.slice(0, el.maxLength);
      const ok = document.execCommand('insertText', false, text);
      if (ok && el.value === expected) return { ok: true, method: 'execCommand', previous, value: el.value };
      log.debug('execCommand did not apply, falling back to native setter', { ok, got: el.value.length, want: expected.length });
    } catch (e) {
      log.debug('execCommand threw', e);
    }
  }

  const set = nativeSetter(el);
  if (!set) return { ok: false, method: 'none', previous, value: el.value };
  set(expected);
  fire(el, 'input', text);
  fire(el, 'change');
  const ok = el.value === expected || (expected === '' && el.value === '');
  return { ok, method: 'setter', previous, value: el.value };
}

function fillContentEditable(target: HTMLElement, text: string, mode: 'replace' | 'cursor'): FillResult {
  const el = editableRoot(target);
  const previous = readValue(el);
  el.focus({ preventScroll: true });
  const sel = el.ownerDocument.getSelection();
  if (sel && (mode === 'replace' || !el.contains(sel.anchorNode))) {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    if (mode === 'cursor') range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const want = normalizeText(text).slice(0, 40);
  const landed = () => normalizeText(readValue(el)).includes(want);

  try {
    if (el.ownerDocument.execCommand('insertText', false, text) && landed()) {
      return { ok: true, method: 'execCommand', previous, value: readValue(el) };
    }
  } catch (e) {
    log.debug('contenteditable execCommand threw', e);
  }

  // Lexical / ProseMirror / Slate handle paste events from a DataTransfer.
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
    if (landed()) return { ok: true, method: 'paste', previous, value: readValue(el) };
  } catch (e) {
    log.debug('synthetic paste failed', e);
  }

  // Plain contenteditable without a framework.
  if (mode === 'replace') el.textContent = text;
  else el.textContent = (el.textContent ?? '') + text;
  fire(el, 'input', text);
  return { ok: landed(), method: 'textContent', previous, value: readValue(el) };
}

/** Score how well an answer matches an option label/value (0..1). */
export function optionScore(answer: string, label: string, value: string): number {
  const a = normalizeText(answer);
  const l = normalizeText(label);
  const v = normalizeText(value);
  if (!a) return 0;
  if (a === v || a === l) return 1;
  if (l && (l.startsWith(a) || a.startsWith(l))) return 0.85;
  if (l && (l.includes(a) || a.includes(l))) return 0.7;
  const at = new Set(a.split(' '));
  const lt = l.split(' ').filter(Boolean);
  if (!lt.length) return 0;
  const overlap = lt.filter((w) => at.has(w)).length;
  return (overlap / Math.max(lt.length, at.size)) * 0.6;
}

export function bestOption<T extends { label: string; value: string }>(answer: string, options: T[]): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const o of options) {
    const s = optionScore(answer, o.label, o.value);
    if (s > bestScore) {
      best = o;
      bestScore = s;
    }
  }
  return bestScore >= 0.3 ? best : null;
}

function fillSelect(el: HTMLSelectElement, text: string): FillResult {
  const previous = el.value;
  const opts = Array.from(el.options)
    .filter((o) => !o.disabled)
    .map((o) => ({ value: o.value, label: collapseWs(o.label || o.text), o }));
  const match = bestOption(text, opts);
  if (!match) return { ok: false, method: 'select', previous, value: el.value };
  el.focus({ preventScroll: true });
  const set = nativeSetter(el);
  if (set) set(match.value);
  else el.value = match.value;
  fire(el, 'input');
  fire(el, 'change');
  return { ok: el.value === match.value, method: 'select', previous, value: match.label };
}

/** Radio group: click the radio whose label best matches. */
export function fillRadioGroup(radios: HTMLInputElement[], text: string, labelOf: (r: HTMLInputElement) => string): FillResult {
  const previous = radios.find((r) => r.checked)?.value ?? '';
  const match = bestOption(
    text,
    radios.map((r) => ({ value: r.value, label: labelOf(r), r })),
  );
  if (!match) return { ok: false, method: 'radio', previous, value: previous };
  if (!match.r.checked) match.r.click();
  return { ok: match.r.checked, method: 'radio', previous, value: match.label };
}

export function fillCheckbox(el: HTMLInputElement, text: string): FillResult {
  const previous = String(el.checked);
  const want = /^(y|yes|true|1|on|checked|agree|i agree)$/i.test(text.trim());
  if (el.checked !== want) el.click();
  return { ok: el.checked === want, method: 'checkbox', previous, value: String(el.checked) };
}

export function fillElement(el: Element, text: string, mode: 'replace' | 'cursor' = 'replace'): FillResult {
  let res: FillResult;
  if (el instanceof HTMLInputElement && el.type === 'checkbox') res = fillCheckbox(el, text);
  else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) res = fillTextControl(el, text, mode);
  else if (el instanceof HTMLSelectElement) res = fillSelect(el, text);
  else if (el instanceof HTMLElement && el.isContentEditable) res = fillContentEditable(el, text, mode);
  else res = { ok: false, method: 'none', previous: '', value: '' };
  log.debug(`fill ${res.ok ? 'ok' : 'FAILED'} via ${res.method}`, { tag: el.tagName, len: text.length });
  return res;
}

/** Restore a previous value (for Undo). */
export function restoreElement(el: Element, previous: string) {
  if (el instanceof HTMLInputElement && el.type === 'checkbox') {
    const want = previous === 'true';
    if (el.checked !== want) el.click();
    return;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const set = nativeSetter(el);
    if (set) set(previous);
    fire(el, 'input');
    fire(el, 'change');
    return;
  }
  if (el instanceof HTMLElement && el.isContentEditable) fillContentEditable(el, previous, 'replace');
}

/** Brief visual confirmation on the filled field. Restores inline styles afterwards. */
export function flash(el: Element, color = '#7c3aed') {
  const h = el as HTMLElement;
  if (!h.style) return;
  const prev = { outline: h.style.outline, transition: h.style.transition, outlineOffset: h.style.outlineOffset };
  h.style.transition = 'outline-color 600ms ease';
  h.style.outline = `2px solid ${color}`;
  h.style.outlineOffset = '1px';
  setTimeout(() => {
    h.style.outline = `2px solid transparent`;
    setTimeout(() => Object.assign(h.style, prev), 650);
  }, 650);
}
