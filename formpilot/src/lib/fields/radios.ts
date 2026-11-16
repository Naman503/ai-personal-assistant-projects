/**
 * Question and option text for a radio group. LinkedIn's Easy Apply (Nov 2026) puts the question
 * in a <p> above a legend-less <fieldset role=radiogroup>, gives every radio the QUESTION as its
 * aria-label, leaves each <label for> empty, and shows the option text in a <p> beside it.
 * The usual label lookup then names every option after the question.
 */
import { resolveLabel } from './context';

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim();

/** Text of an element, skipping form controls and the text of nested radio groups. */
const textOf = (el: Element) => clean((el as HTMLElement).innerText || el.textContent);

function legend(radio: HTMLInputElement): string {
  const lg = radio.closest('fieldset')?.querySelector('legend');
  if (!lg) return '';
  let t = clean(lg.querySelector('[aria-hidden="true"]')?.textContent || lg.textContent);
  const half = t.length / 2;
  if (Number.isInteger(half) && t.slice(0, half) === t.slice(half)) t = t.slice(0, half).trim();
  return t;
}

/** The question a radio group asks. */
export function radioGroupLabel(radios: HTMLInputElement[]): string {
  const first = radios[0];
  const lg = legend(first);
  if (lg) return lg;
  const group = first.closest('fieldset, [role="radiogroup"]');
  const byId = group?.getAttribute('aria-labelledby');
  if (byId) {
    const t = clean(byId.split(/\s+/).map((id) => (first.getRootNode() as Document).getElementById?.(id)?.textContent ?? '').join(' '));
    if (t) return t;
  }
  if (group?.getAttribute('aria-label')) return clean(group.getAttribute('aria-label'));
  // Every radio has the same aria-label: that's the question.
  const aria = first.getAttribute('aria-label');
  if (aria && radios.length > 1 && radios.every((r) => r.getAttribute('aria-label') === aria)) return clean(aria);
  // Text just before the group (a <p>/<span>/<label> heading).
  let prev = group?.previousElementSibling;
  for (let i = 0; i < 3 && prev; i++, prev = prev.previousElementSibling) {
    if (prev.querySelector('input, select, textarea')) break;
    const t = textOf(prev);
    if (t) return t;
  }
  return clean(resolveLabel(first.parentElement as HTMLElement)) || first.name;
}

/** The text of one option. */
export function radioOptionLabel(radio: HTMLInputElement, radios: HTMLInputElement[] = [radio]): string {
  const shared = radios.length > 1 && radios.every((r) => r.getAttribute('aria-label') === radio.getAttribute('aria-label'));
  // A <label for> with text, or wrapping the radio.
  const lab = [...(radio.labels ?? [])].map(textOf).find(Boolean);
  if (lab) return lab;
  if (!shared) {
    const own = clean(resolveLabel(radio));
    if (own) return own;
  }
  // Climb to the nearest ancestor that holds this radio only and has text: that's the option row.
  let p = radio.parentElement;
  for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
    if (p.querySelectorAll('input[type="radio"]').length > 1) break;
    const t = textOf(p);
    if (t) return t;
  }
  return radio.value && radio.value !== 'on' ? radio.value : clean(radio.getAttribute('aria-label'));
}
