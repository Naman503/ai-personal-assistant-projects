/**
 * Typeahead boxes (LinkedIn "City", "Location", school, skills): typing isn't enough, the site
 * only accepts a value picked from its suggestion list ("Please enter a valid answer"). After a
 * fill, wait for the list and pick the closest suggestion.
 */
import { createLogger } from '../logger';

const log = createLogger('fill');

export function isTypeahead(el: Element): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false;
  const role = el.getAttribute('role');
  const ac = el.getAttribute('aria-autocomplete');
  return role === 'combobox' || ac === 'list' || ac === 'both' || el.getAttribute('aria-haspopup') === 'listbox';
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function visible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect?.();
  return !!r && r.width > 0 && r.height > 0;
}

/** The suggestions shown for this box right now. */
export function suggestionsFor(el: HTMLInputElement): HTMLElement[] {
  const root = el.getRootNode() as Document | ShadowRoot;
  const ids = `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.split(/\s+/).filter(Boolean);
  const lists = ids.map((id) => root.getElementById?.(id) ?? document.getElementById(id)).filter((x): x is HTMLElement => !!x);
  const pool = lists.length ? lists : [...root.querySelectorAll<HTMLElement>('[role=listbox]')].filter(visible);
  return pool.flatMap((l) => [...l.querySelectorAll<HTMLElement>('[role=option]')]).filter(visible);
}

/** Best suggestion for the typed value: exact, then starts-with, then contains; else the first. */
export function bestSuggestion(value: string, options: HTMLElement[]): HTMLElement | null {
  const v = norm(value);
  const text = (o: HTMLElement) => norm(o.innerText || o.textContent || '');
  return options.find((o) => text(o) === v) ?? options.find((o) => text(o).startsWith(v)) ?? options.find((o) => text(o).includes(v)) ?? options[0] ?? null;
}

/** After typing into a typeahead box, pick from its list (waits up to 3 s for it to appear). */
export async function pickSuggestion(el: Element, value: string, wait = 3000): Promise<boolean> {
  if (!isTypeahead(el) || !value.trim()) return false;
  const end = Date.now() + wait;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
    const opts = suggestionsFor(el);
    if (!opts.length) continue;
    const pick = bestSuggestion(value, opts);
    if (!pick) return false;
    const label = (pick.innerText || pick.textContent || '').trim();
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) pick.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true }));
    pick.click();
    log.info(`picked suggestion "${label.slice(0, 60)}" for "${value.slice(0, 40)}"`);
    return true;
  }
  log.info(`no suggestion list appeared for "${value.slice(0, 40)}"`);
  return false;
}
