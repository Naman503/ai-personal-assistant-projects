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
  // LinkedIn repeats the question in an aria-hidden span; a hidden "*" alone is just the required mark.
  const hidden = clean(lg.querySelector('[aria-hidden="true"]')?.textContent);
  let t = clean(hidden.length > 2 ? hidden : lg.textContent);
  const half = t.length / 2;
  if (Number.isInteger(half) && t.slice(0, half) === t.slice(half)) t = t.slice(0, half).trim();
  return t;
}

/** The question a radio group asks. */
export function radioGroupLabel(radios: HTMLInputElement[]): string {
  const first = radios[0];
  const lg = legend(first);
  if (lg) return lg;
  const group = first.closest('fieldset, [role="radiogroup"], [role="group"]');
  const byId = group?.getAttribute('aria-labelledby');
  if (byId) {
    const t = clean(byId.split(/\s+/).map((id) => (first.getRootNode() as Document).getElementById?.(id)?.textContent ?? '').join(' '));
    if (t) return t;
  }
  if (group?.getAttribute('aria-label')) return clean(group.getAttribute('aria-label'));
  // Every radio has the same aria-label: that's the question.
  const aria = first.getAttribute('aria-label');
  if (aria && radios.length > 1 && radios.every((r) => r.getAttribute('aria-label') === aria)) return clean(aria);
  // Text just before the group (a <p>/<span>/<label> heading); for a group without a container,
  // the text before the common parent of its options. Lever-style markup nests the options one or
  // two levels below the question, so look before each ancestor too (until one holds other fields).
  let box: Element | null = group ?? commonParent(radios);
  for (let level = 0; level < 4 && box; level++, box = box.parentElement) {
    let prev = box.previousElementSibling;
    for (let i = 0; i < 3 && prev; i++, prev = prev.previousElementSibling) {
      if (prev.querySelector('input, select, textarea')) break;
      const t = textOf(prev);
      if (t) return t;
    }
    const parent = box.parentElement;
    if (!parent || [...parent.querySelectorAll('input, select, textarea')].some((x) => !radios.includes(x as HTMLInputElement))) break;
  }
  const fallback = clean(resolveLabel(first.parentElement as HTMLElement));
  // A label that is just one of the options ("Yes") is no question.
  const options = new Set(radios.map((r) => radioOptionLabel(r, radios).toLowerCase()));
  return fallback && !options.has(fallback.toLowerCase()) ? fallback : first.name;
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
    if (p.querySelectorAll(`input[type="${radio.type}"]`).length > 1) break;
    const t = textOf(p);
    if (t) return t;
  }
  return radio.value && radio.value !== 'on' ? radio.value : clean(radio.getAttribute('aria-label'));
}

function commonParent(els: Element[]): Element | null {
  let p = els[0]?.parentElement ?? null;
  while (p && !els.every((e) => p!.contains(e))) p = p.parentElement;
  return p;
}
