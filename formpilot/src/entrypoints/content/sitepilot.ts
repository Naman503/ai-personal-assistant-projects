/**
 * Site Pilot in the page: one "round" of work on a company's application form.
 *
 *   checks (closed job, sign-in wall, CAPTCHA) → find the form (press "Apply" on a job page) →
 *   resume upload → answers through the local model (the normal form fill, local engine) →
 *   custom controls (Google Forms options, Yes/No buttons, role=listbox) → consent →
 *   look-and-act loop (snapshot + screenshot → the model's one action) → Submit (live) or stop
 *   before it (dry run) → confirmation.
 *
 * A round ends when the page navigates (the runner starts the next one on the new page) or with
 * a result. Nothing here sends anything by itself: Submit is pressed only after the runner says
 * this system is live.
 */
import { createLogger } from '@/lib/logger';
import { classifyField } from '@/lib/fields/classify';
import { fillElement, bestOption, fillRadioGroup, fillCheckboxGroup } from '@/lib/fields/fill';
import { pickSuggestion } from '@/lib/fields/typeahead';
import { repairValue, specOf } from '@/lib/fields/adapt';
import { extractField, isVisible, readValue, resolveLabel, radioGroups, checkboxGroups, type FillableElement } from '@/lib/fields/context';
import { radioGroupLabel, radioOptionLabel } from '@/lib/fields/radios';
import { buttonText, fieldErrors, settled, STEP_RE, visibleError, isUnchosen } from '@/lib/walk';
import { CONFIRMATION_URL_RE, deepText, isConfirmation, looksLikeSubmit } from '@/lib/job';
import { humanClick } from '@/lib/queue';
import { quietFocus } from '@/lib/automation';
import { rpc } from '@/lib/messages';
import { blockerIn, CLOSED_RE, consentToTick, declineOption, detectAts, EEO_RE, isResumeField, MARKETING_RE, OPEN_FORM_RE } from '@/lib/sitepilot/detect';
import type { AgentAction, PageSnapshot, RoundContext, RoundResult, SnapControl, SpAnswer } from '@/lib/sitepilot/types';
import type { FieldContext } from '@/lib/types';

const log = createLogger('sitepilot');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Google Forms and other "we got it" pages that the general pattern misses. */
const SITE_CONFIRM_RE = /\b(your response has been recorded|response (has been )?(recorded|submitted)|thanks? (you )?for (your )?(response|submission|interest)|application (is )?complete|we('ll| will) (be in touch|get back to you|review your application)|successfully submitted)\b/i;

export type FillFn = (anchor: HTMLElement) => Promise<{ filled: number; total: number; error?: string }>;

/** A control the page knows by id for this round. */
interface Target {
  id: string;
  kind: SnapControl['kind'];
  el: HTMLElement;
  label: string;
  required: boolean;
  /** Options of a choice: the element to click (or the native radio/checkbox) and its text. */
  options?: { label: string; el: HTMLElement }[];
  native?: boolean;
}

const VISIBLE_INPUTS = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), select, textarea, [contenteditable="true"]';
const BUTTONS = 'button, input[type=submit], input[type=button], a[role=button], [role=button], a[href]';

const textOf = (el: Element | null | undefined) => clean((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '');

function idsText(ids: string | null): string {
  if (!ids) return '';
  return ids
    .split(/\s+/)
    .map((id) => textOf(document.getElementById(id)))
    .filter(Boolean)
    .join(' ');
}

/** The question a custom control group belongs to. */
function questionOf(group: HTMLElement, optionTexts: string[] = []): string {
  const by = idsText(group.getAttribute('aria-labelledby')) || clean(group.getAttribute('aria-label'));
  if (by) return by;
  // Walk up to a container with a heading/label that isn't one of the options.
  let p: HTMLElement | null = group;
  for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
    const head = p.querySelector<HTMLElement>('legend, label, [role=heading], h1, h2, h3, h4, h5, .label, [class*="label" i], [class*="question" i], [class*="title" i]');
    const t = textOf(head);
    if (t && !optionTexts.includes(t) && t.length < 300) return t;
  }
  return '';
}

const isRequired = (el: Element, label: string) =>
  (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label) || /\((required|mandatory)\)/i.test(label);

function visibleControlsIn(scope: Element): number {
  let n = 0;
  for (const el of scope.querySelectorAll<HTMLElement>(`${VISIBLE_INPUTS}, [role=radio], [role=checkbox], [role=listbox]`)) if (isVisible(el) || (el as HTMLInputElement).type === 'file') n++;
  return n;
}

/** The application form on this page: the form/dialog with the most visible fields. */
function formScope(): HTMLElement | null {
  let best: HTMLElement | null = null;
  let score = 0;
  for (const c of document.querySelectorAll<HTMLElement>('form, [role=form], [role=dialog], [aria-modal=true]')) {
    if (!isVisible(c)) continue;
    const n = visibleControlsIn(c);
    // A search box or newsletter form is not the application.
    if (n > score && !(n <= 2 && /search|subscribe|newsletter/i.test(c.getAttribute('action') ?? '' + (c.className || '')))) {
      best = c;
      score = n;
    }
  }
  if (best && score >= 2) return best;
  return visibleControlsIn(document.body) >= 3 ? document.body : null;
}

function captchaShown(): boolean {
  // Text CAPTCHAs (Keka and others): an image plus a box to type what it says.
  const typed = [...document.querySelectorAll<HTMLInputElement>('input')].some((i) => isVisible(i) && /captcha/i.test(`${i.name} ${i.id} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`));
  if (typed) return true;
  const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"], iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"]')];
  // The invisible reCAPTCHA badge (bottom right, tiny) doesn't stop anyone; a visible box does.
  return frames.some((f) => {
    const r = f.getBoundingClientRect();
    return isVisible(f) && r.width > 120 && r.height > 50 && !/size=invisible/.test(f.src);
  });
}

function confirmed(): boolean {
  const t = deepText(document, 30_000);
  return isConfirmation(t) || SITE_CONFIRM_RE.test(t) || CONFIRMATION_URL_RE.test(location.pathname) || /\/formResponse\b/.test(location.pathname);
}

/** An embedded application (Greenhouse/Lever/Ashby/Google Forms in an iframe): its address. */
function embeddedForm(): string | null {
  const f = [...document.querySelectorAll<HTMLIFrameElement>('iframe[src]')].find((x) => /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|docs\.google\.com\/forms|smartrecruiters|zohorecruit|keka\.com|darwinbox|freshteam/i.test(x.src) && isVisible(x));
  return f?.src ?? null;
}

/** Reject non-essential cookies when the banner offers it (never "accept all" for you). */
function dismissCookies() {
  const b = [...document.querySelectorAll<HTMLElement>('button, [role=button], a')].find((x) => isVisible(x) && /^(reject( all)?|decline( all)?|only (necessary|essential)|necessary only|use necessary cookies only|refuse)( cookies)?$/i.test(textOf(x)));
  if (b) {
    humanClick(b);
    log.info(`cookie banner: pressed "${textOf(b)}"`);
  }
}

// ---------------- reading the form ----------------

/** Custom (non-native) choice groups: ARIA radios/checkboxes/listboxes and Yes/No buttons. */
function customGroups(scope: Element): { el: HTMLElement; kind: 'radio' | 'checkboxes' | 'listbox' | 'buttons'; options: { label: string; el: HTMLElement }[]; label: string; required: boolean }[] {
  const out: ReturnType<typeof customGroups> = [];
  const optLabel = (o: HTMLElement) => clean(o.getAttribute('aria-label') || o.getAttribute('data-value') || o.getAttribute('data-answer-value') || textOf(o));
  for (const g of scope.querySelectorAll<HTMLElement>('[role=radiogroup]')) {
    if (!isVisible(g) || [...g.querySelectorAll<HTMLInputElement>('input[type=radio]')].some((r) => isVisible(r))) continue; // visible native radios: the normal fill
    const options = [...g.querySelectorAll<HTMLElement>('[role=radio]')].map((el) => ({ el, label: optLabel(el) })).filter((o) => o.label);
    if (!options.length) continue;
    const label = questionOf(g, options.map((o) => o.label));
    out.push({ el: g, kind: 'radio', options, label, required: isRequired(g, label) || g.closest('[aria-required=true]') !== null });
  }
  // ARIA radios without a radiogroup (Workable's Yes/No): group them by their nearest shared box.
  const loose = [...scope.querySelectorAll<HTMLElement>('[role=radio]')].filter((r) => !r.closest('[role=radiogroup]') && isVisible(r));
  const taken = new Set<HTMLElement>();
  for (const r of loose) {
    if (taken.has(r)) continue;
    let box: HTMLElement | null = r.parentElement;
    while (box && box !== scope && box.querySelectorAll('[role=radio]').length < 2) box = box.parentElement;
    if (!box || box === scope) continue;
    const members = loose.filter((x) => box!.contains(x));
    members.forEach((x) => taken.add(x));
    const options = members.map((el) => ({ el, label: idsText(el.getAttribute('aria-labelledby')) || optLabel(el) })).filter((o) => o.label);
    if (options.length < 2) continue;
    const label = questionOf(box, options.map((o) => o.label));
    out.push({ el: box, kind: 'radio', options, label, required: members.some((m) => m.getAttribute('aria-required') === 'true') || isRequired(box, label) });
  }
  // ARIA checkboxes, grouped by their list (Google Forms "check all that apply").
  const seen = new Set<HTMLElement>();
  for (const c of scope.querySelectorAll<HTMLElement>('[role=checkbox]')) {
    if (seen.has(c) || !isVisible(c) || c.tagName === 'INPUT') continue;
    const list = c.closest<HTMLElement>('[role=list], [role=group]') ?? c.parentElement!;
    const boxes = [...list.querySelectorAll<HTMLElement>('[role=checkbox]')].filter((x) => x.tagName !== 'INPUT');
    boxes.forEach((b) => seen.add(b));
    const options = boxes.map((el) => ({ el, label: optLabel(el) }));
    const label = questionOf(list, options.map((o) => o.label));
    out.push({ el: list, kind: 'checkboxes', options, label, required: isRequired(list, label) || list.closest('[aria-required=true]') !== null });
  }
  for (const lb of scope.querySelectorAll<HTMLElement>('[role=listbox]')) {
    if (!isVisible(lb) || lb.tagName === 'SELECT' || lb.closest('[role=combobox]')?.tagName === 'INPUT') continue;
    const options = [...lb.querySelectorAll<HTMLElement>('[role=option]')].map((el) => ({ el, label: optLabel(el) })).filter((o) => o.label && !/^(choose|select)\b/i.test(o.label));
    if (!options.length) continue;
    const label = questionOf(lb, options.map((o) => o.label));
    out.push({ el: lb, kind: 'listbox', options, label, required: isRequired(lb, label) || lb.closest('[aria-required=true]') !== null });
  }
  // Yes/No buttons (Ashby and others): 2–4 short buttons side by side under a question.
  for (const wrap of scope.querySelectorAll<HTMLElement>('div, fieldset, span')) {
    const shownKids = [...wrap.children].filter((c) => isVisible(c as HTMLElement));
    const btns = shownKids.filter((c): c is HTMLElement => c.tagName === 'BUTTON');
    if (btns.length < 2 || btns.length > 4 || btns.length !== shownKids.length) continue;
    const labels = btns.map((b) => textOf(b));
    if (!labels.every((l) => /^(yes|no|maybe|not sure|true|false)$/i.test(l))) continue;
    const label = questionOf(wrap, labels);
    out.push({ el: wrap, kind: 'buttons', options: btns.map((el, i) => ({ el, label: labels[i] })), label, required: isRequired(wrap, label) });
  }
  return out;
}

const chosen = (o: HTMLElement) =>
  o.getAttribute('aria-checked') === 'true' || o.getAttribute('aria-selected') === 'true' || o.getAttribute('aria-pressed') === 'true' || /\b(selected|active|checked|is-selected|_active)\b/i.test(o.className);

function groupValue(g: ReturnType<typeof customGroups>[number]): string {
  if (g.kind === 'listbox') {
    const sel = g.options.find((o) => o.el.getAttribute('aria-selected') === 'true' && !/^(choose|select)\b/i.test(o.label));
    return sel?.label ?? '';
  }
  return g.options
    .filter((o) => chosen(o.el))
    .map((o) => o.label)
    .join(' | ');
}

/** The look of the form, for the model and for our own checks. Fills `reg` with id → element. */
function snapshot(scope: HTMLElement, reg: Map<string, Target>, ats: string): PageSnapshot {
  reg.clear();
  const controls: SnapControl[] = [];
  const missing: string[] = [];
  let f = 0;
  let b = 0;
  const errs = fieldErrors(scope).filter((e) => e.shown);
  const errOf = (el: Element) => errs.find((e) => e.field === el)?.msg;
  const add = (t: Omit<Target, 'id'>, value: string, extra: Partial<SnapControl> = {}) => {
    const id = t.kind === 'button' || t.kind === 'link' ? `b${++b}` : `f${++f}`;
    reg.set(id, { ...t, id });
    const c: SnapControl = { id, kind: t.kind, label: t.label.slice(0, 200), required: t.required || undefined, value, ...extra };
    if (t.options) c.options = t.options.map((o) => o.label).slice(0, 20);
    controls.push(c);
    if (t.required && !value && t.kind !== 'button' && t.kind !== 'link') missing.push(t.label || id);
  };
  const doneRadio = new Set<string>();
  for (const [name, radios] of radioGroups(scope)) {
    if (!radios.some((r) => isVisible(r) || isVisible(r.parentElement!))) continue;
    doneRadio.add(name);
    const label = radioGroupLabel(radios);
    const options = radios.map((r) => ({ el: r as HTMLElement, label: radioOptionLabel(r, radios) }));
    const sel = radios.find((r) => r.checked);
    add({ kind: 'radio', el: radios[0], label, required: radios.some((r) => r.required) || /\*\s*$/.test(label), options, native: true }, sel ? radioOptionLabel(sel, radios) : '', { error: errOf(radios[0]) });
  }
  const groupedBoxes = new Set<HTMLInputElement>();
  for (const boxes of checkboxGroups(scope)) {
    boxes.forEach((x) => groupedBoxes.add(x));
    const label = radioGroupLabel(boxes);
    const options = boxes.map((x) => ({ el: x as HTMLElement, label: radioOptionLabel(x, boxes) }));
    add({ kind: 'checkboxes', el: boxes[0], label, required: /\*\s*$/.test(label), options, native: true }, boxes.filter((x) => x.checked).map((x) => radioOptionLabel(x, boxes)).join(' | '));
  }
  for (const el of scope.querySelectorAll<HTMLElement>(VISIBLE_INPUTS)) {
    const input = el as HTMLInputElement;
    const type = (input.type || '').toLowerCase();
    if (type === 'radio' || type === 'password' || groupedBoxes.has(input)) continue;
    if (type === 'file') {
      const label = fileLabel(input);
      const has = (input.files?.length ?? 0) > 0 || fileShown(input);
      add({ kind: 'file', el, label, required: isRequired(el, label) }, has ? (input.files?.[0]?.name ?? 'attached') : '');
      continue;
    }
    if (!isVisible(el)) continue;
    const label = resolveLabel(el as FillableElement) || clean(el.getAttribute('placeholder'));
    if (type === 'checkbox') {
      add({ kind: 'checkbox', el, label, required: isRequired(el, label), native: true }, input.checked ? 'checked' : '', { error: errOf(el) });
      continue;
    }
    if (el instanceof HTMLSelectElement) {
      const options = [...el.options].filter((o) => o.value !== '' || o.index > 0).map((o) => ({ label: clean(o.text), el: o as unknown as HTMLElement }));
      add({ kind: 'select', el, label, required: isRequired(el, label), options, native: true }, isUnchosen(el) ? '' : clean(el.selectedOptions[0]?.text), { error: errOf(el) });
      continue;
    }
    const combo = el.getAttribute('role') === 'combobox';
    const kind: SnapControl['kind'] = el.tagName === 'TEXTAREA' || el.isContentEditable ? 'textarea' : combo ? 'combobox' : (['email', 'tel', 'number', 'date', 'url'].includes(type) ? type : 'text') as SnapControl['kind'];
    // react-select shows the picked value next to the (empty) input.
    const shown = combo ? comboChosen(el) : '';
    add({ kind, el, label, required: isRequired(el, label), native: true }, clean(readValue(el as FillableElement)) || shown, { error: errOf(el) });
  }
  for (const el of scope.querySelectorAll<HTMLElement>('[role=combobox][aria-haspopup=listbox]:not(input)')) {
    if (!isVisible(el)) continue;
    const label = idsText(el.getAttribute('aria-labelledby')) || clean(el.getAttribute('aria-label')) || questionOf(el);
    add({ kind: 'combobox', el, label, required: isRequired(el, label) }, comboChosen(el), { error: el.getAttribute('aria-invalid') === 'true' ? 'required' : undefined });
  }
  for (const g of customGroups(scope)) {
    add({ kind: g.kind === 'checkboxes' ? 'checkboxes' : g.kind === 'listbox' ? 'select' : 'radio', el: g.el, label: g.label, required: g.required, options: g.options }, groupValue(g));
  }
  for (const el of scope.querySelectorAll<HTMLElement>(BUTTONS)) {
    if (!isVisible(el) || el.closest('[role=radiogroup],[role=listbox]') || el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') continue;
    const t = buttonText(el);
    if (!t || t.length > 60) continue;
    if (/^(yes|no)$/i.test(t) && el.parentElement && [...el.parentElement.children].every((c) => /^(yes|no|maybe)$/i.test(textOf(c)))) continue;
    if (el.tagName === 'A' && !OPEN_FORM_RE.test(t) && !STEP_RE.test(t) && !looksLikeSubmit(t)) continue;
    add({ kind: el.tagName === 'A' ? 'link' : 'button', el, label: t, required: false }, '');
    if (b >= 25) break;
  }
  const v = visibleError(scope);
  const errors = [...errs.map((e) => `${e.label || 'a field'}: ${e.msg}`), ...(v && !errs.some((e) => v.contains(e.field)) ? [textOf(v).slice(0, 160)] : [])].slice(0, 8);
  const text = [...document.querySelectorAll<HTMLElement>('h1, h2, h3, [role=heading], [role=alert], [class*="progress" i], [class*="step" i]')]
    .filter((h) => isVisible(h))
    .map((h) => textOf(h))
    .filter((t) => t && t.length < 200)
    .slice(0, 12)
    .join(' | ');
  const submit = submitButton(scope);
  return { url: location.href, title: document.title, ats, text, controls, missing, errors, submitReady: !!submit && !missing.length && !errors.length };
}

function fileLabel(input: HTMLInputElement): string {
  const generic = /^(file|upload|choose( a)? file|select( a)? file|attach|browse|drop( your)? files?( here)?|add file)$/i;
  const group = input.closest('[role=group][aria-labelledby], fieldset');
  const byGroup = group ? idsText(group.getAttribute('aria-labelledby')) || textOf(group.querySelector('legend')) : '';
  const own = resolveLabel(input);
  const ids = clean(`${input.id} ${input.name}`.replace(/[_-]+/g, ' '));
  if (byGroup) return byGroup;
  if (own && !generic.test(own)) return own;
  let p: HTMLElement | null = input.parentElement;
  for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
    const t = textOf(p);
    if (t && t.length < 200 && !generic.test(t)) return t;
  }
  return ids || 'file';
}

/** The uploader already shows a file (some hide the input and show the name instead). */
function fileShown(input: HTMLInputElement): boolean {
  let p: HTMLElement | null = input.parentElement;
  for (let i = 0; i < 4 && p; i++, p = p.parentElement) if (/[\w)\]-]\.(pdf|docx?|rtf)\b/i.test(textOf(p))) return true; // a file name, not a hint like "(.pdf, .docx)"
  return false;
}

/** The button that sends the form: "Submit…" first, then "Send application", then "Apply" inside the form. */
function submitButton(scope: Element): HTMLElement | null {
  const btns = [...scope.querySelectorAll<HTMLElement>('button, input[type=submit], [role=button]')].filter((x) => isVisible(x) && !(x as HTMLButtonElement).disabled);
  const t = (x: HTMLElement) => buttonText(x);
  return (
    btns.find((x) => /^submit\b|\bsubmit (application|my application|form)\b/i.test(t(x))) ??
    btns.find((x) => /\bsend application\b|\bcomplete application\b|\bfinish\b/i.test(t(x))) ??
    (scope.tagName === 'FORM' ? btns.find((x) => /^apply\b/i.test(t(x)) && !OPEN_FORM_RE.test(t(x)) && x.closest('form') === scope) ?? btns.find((x) => (x as HTMLInputElement).type === 'submit' && looksLikeSubmit(t(x))) : null) ??
    null
  );
}

function nextButton(scope: Element): HTMLElement | null {
  return [...scope.querySelectorAll<HTMLElement>('button, input[type=submit], input[type=button], [role=button]')].find((x) => isVisible(x) && !(x as HTMLButtonElement).disabled && STEP_RE.test(buttonText(x))) ?? null;
}

// ---------------- acting ----------------

async function pressOption(o: HTMLElement) {
  o.scrollIntoView?.({ block: 'center' });
  humanClick(o);
  await sleep(250);
}

/** Pick an option of a custom listbox (Google Forms dropdown): open it, then click the option in the popup. */
async function chooseListbox(lb: HTMLElement, option: string): Promise<boolean> {
  humanClick(lb);
  await sleep(500);
  const all = [...document.querySelectorAll<HTMLElement>('[role=option]')].filter((o) => isVisible(o));
  const pick = bestOption(option, all.map((el) => ({ el, label: clean(el.getAttribute('data-value') || textOf(el)), value: clean(el.getAttribute('data-value') || textOf(el)) })));
  if (!pick) {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }
  humanClick(pick.el);
  await sleep(500);
  return true;
}

async function chooseIn(t: Target, option: string): Promise<boolean> {
  if (t.kind === 'combobox') return chooseCombo(t.el, option);
  if (t.native && t.el instanceof HTMLSelectElement) return fillElement(t.el, option, 'replace', t.label).ok;
  if (t.native && t.kind === 'radio' && t.options) return fillRadioGroup(t.options.map((o) => o.el as HTMLInputElement), option, (x) => t.options!.find((o) => o.el === x)?.label ?? '', t.label).ok;
  if (t.native && t.kind === 'checkboxes' && t.options) return fillCheckboxGroup(t.options.map((o) => o.el as HTMLInputElement), option, (x) => t.options!.find((o) => o.el === x)?.label ?? '').ok;
  if (t.el.getAttribute('role') === 'listbox') return chooseListbox(t.el, option);
  if (!t.options?.length) return false;
  const parts = t.kind === 'checkboxes' ? option.split(/\s*\|\s*|\s*,\s*/) : [option];
  let ok = false;
  for (const p of parts) {
    const o = bestOption(p, t.options.map((x) => ({ ...x, value: x.label })));
    if (o && !chosen(o.el)) {
      await pressOption(o.el);
      ok = true;
    } else if (o) ok = true;
  }
  return ok;
}

let resumeCache: File | null | undefined;
async function resumeFile(): Promise<File | null> {
  if (resumeCache !== undefined) return resumeCache;
  const r = await rpc<{ name: string; type: string; b64: string } | null>({ type: 'sp-resume' }).catch(() => null);
  if (!r) return (resumeCache = null);
  const bin = atob(r.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return (resumeCache = new File([bytes], r.name, { type: r.type || 'application/pdf' }));
}

async function putFile(input: HTMLInputElement): Promise<boolean> {
  const file = await resumeFile();
  if (!file) return false;
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/** Put the resume into the resume field (only a resume field; cover letters etc. are left). */
async function uploadResume(scope: Element): Promise<string> {
  const inputs = [...scope.querySelectorAll<HTMLInputElement>('input[type=file]')];
  if (!inputs.length) return '';
  const resume = inputs.find((i) => isResumeField(fileLabel(i), i.accept)) ?? inputs.find((i) => /\b(resume|cv)\b/i.test(`${i.id} ${i.name}`.replace(/[_-]+/g, ' '))) ?? (inputs.length === 1 && !/cover|photo|portfolio/i.test(fileLabel(inputs[0])) ? inputs[0] : null);
  if (!resume) return '';
  if ((resume.files?.length ?? 0) > 0 || fileShown(resume)) return '';
  if (!(await putFile(resume))) return 'no resume file saved in Site Pilot (add it on the Site Pilot page)';
  await settled(document.body, 800, 6000); // some sites read the resume and fill fields from it
  return `resume uploaded (${resumeCache?.name})`;
}

/** "Link to your resume" boxes: your saved link (never a guess). */
function fillResumeLink(scope: HTMLElement, link: string | undefined): SpAnswer[] {
  if (!link?.trim()) return [];
  const out: SpAnswer[] = [];
  for (const el of scope.querySelectorAll<HTMLInputElement>('input[type=text], input[type=url], input:not([type])')) {
    if (!isVisible(el) || el.value.trim()) continue;
    const label = resolveLabel(el);
    if (!/\b(resume|cv)\b.*\b(link|url|drive|dropbox)\b|\b(link|url)\b.*\b(resume|cv)\b/i.test(label)) continue;
    if (fillElement(el, link.trim(), 'replace', label).ok) {
      el.setAttribute('data-fp-handled', '1');
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      out.push({ q: label, a: link.trim(), src: 'your resume link' });
    }
  }
  return out;
}

/** Demographic questions: "Decline to self-identify" when the question offers it. */
async function declineDemographics(scope: HTMLElement, reg: Map<string, Target>): Promise<SpAnswer[]> {
  const snap = snapshot(scope, reg, '');
  const out: SpAnswer[] = [];
  for (const c of snap.controls) {
    if (c.value || !c.options?.length || !EEO_RE.test(c.label)) continue;
    const d = declineOption(c.label, c.options);
    const t = reg.get(c.id);
    if (d && t && (await chooseIn(t, d))) out.push({ q: c.label, a: d, src: 'rule: decline demographic' });
  }
  return out;
}

/** Tick required privacy/terms boxes; never marketing ones. */
function tickConsent(scope: HTMLElement): SpAnswer[] {
  const out: SpAnswer[] = [];
  // Each box on its own (a consent box often sits next to a marketing one in the same group).
  for (const box of scope.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
    if (box.checked || !(isVisible(box) || isVisible(box.parentElement!))) continue;
    const label = radioOptionLabel(box, [box]) || resolveLabel(box);
    if (!consentToTick(label, box.required || box.getAttribute('aria-required') === 'true')) continue;
    humanClick(box);
    out.push({ q: label.slice(0, 160), a: 'ticked', src: 'rule: required consent' });
  }
  // ARIA checkbox lists with a single box are consent boxes too (Google Forms "I agree").
  for (const g of customGroups(scope)) {
    if (g.kind !== 'checkboxes' || g.options.length !== 1 || chosen(g.options[0].el)) continue;
    const label = `${g.label} ${g.options[0].label}`;
    if (consentToTick(label, g.required)) {
      humanClick(g.options[0].el);
      out.push({ q: label.slice(0, 160), a: 'ticked', src: 'rule: required consent' });
    }
  }
  return out;
}

/** Custom choice groups still empty: answer them through the local model, then click the choices. */
async function fillCustom(scope: HTMLElement): Promise<SpAnswer[]> {
  const groups = customGroups(scope).filter((g) => !groupValue(g) && g.label && !(g.kind === 'checkboxes' && g.options.length === 1));
  if (!groups.length) return [];
  const fields = groups.map((g, i) => {
    const field: FieldContext = {
      fid: `spc${i}`,
      kind: 'select',
      inputType: g.kind === 'checkboxes' ? 'checkbox' : 'radio',
      label: g.label,
      name: '',
      htmlId: '',
      placeholder: '',
      autocomplete: '',
      description: '',
      section: '',
      required: g.required,
      options: g.options.map((o) => ({ value: o.label, label: o.label })),
      currentValue: '',
      semantic: classifyField({ label: g.label }),
      longForm: false,
    };
    return { id: `c${i + 1}`, field };
  });
  const page = { url: location.href, host: location.hostname, title: document.title, heading: textOf(document.querySelector('h1')), formTitle: '', pageText: deepText(document, 3000), otherFields: [] } as unknown as import('@/lib/types').PageContext;
  const res = await rpc<{ values: Record<string, string>; sources: Record<string, string> }>({ type: 'fill-form', fields, page, engine: 'local' }).catch((e) => {
    log.info(`custom questions: ${(e as Error).message}`);
    return { values: {}, sources: {} } as { values: Record<string, string>; sources: Record<string, string> };
  });
  const out: SpAnswer[] = [];
  for (const [i, g] of groups.entries()) {
    const v = res.values[`c${i + 1}`];
    if (!v?.trim()) continue;
    const t: Target = { id: '', kind: g.kind === 'checkboxes' ? 'checkboxes' : 'radio', el: g.el, label: g.label, required: g.required, options: g.options };
    const ok = await chooseIn(t, v);
    log.info(`${ok ? '✓' : '✗'} "${g.label.slice(0, 80)}" ← ${JSON.stringify(v.slice(0, 60))}`, { source: res.sources[`c${i + 1}`] ?? '' });
    if (ok) out.push({ q: g.label, a: v, src: res.sources[`c${i + 1}`] });
  }
  return out;
}

/** react-select style dropdowns (Greenhouse): an input with role=combobox inside a "control" box. */
function comboControl(input: HTMLElement): HTMLElement {
  return input.closest<HTMLElement>('[class*="select__control" i], [class*="-control" i], [class*="control" i]') ?? input;
}
function comboChosen(input: HTMLElement): string {
  // A button-style combobox (Workable) shows the choice as its own text.
  if (input.tagName !== 'INPUT') {
    const t = textOf(input);
    return /^(select|choose|please select)\b|^-+$/i.test(t) ? '' : t;
  }
  return textOf(comboControl(input).querySelector('[class*="single-value" i], [class*="singleValue" i], [class*="multi-value__label" i]'));
}
async function comboOptions(input: HTMLElement): Promise<HTMLElement[]> {
  if (input.tagName !== 'INPUT') {
    if (input.getAttribute('aria-expanded') !== 'true') humanClick(input);
  } else {
    const ctl = comboControl(input);
    for (const t of ['mousedown', 'mouseup'] as const) ctl.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0 }));
    input.focus();
  }
  await sleep(350);
  const listId = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
  const list = listId ? document.getElementById(listId) : null;
  const opts = [...(list ?? document).querySelectorAll<HTMLElement>('[role=option], [class*="select__option" i]')].filter((o) => isVisible(o));
  return opts;
}
function closeCombo(input: HTMLElement) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  if (input.tagName !== 'INPUT' && input.getAttribute('aria-expanded') === 'true') humanClick(input);
  input.blur();
}
async function chooseCombo(input: HTMLElement, option: string): Promise<boolean> {
  let opts = await comboOptions(input);
  if (!opts.length && input.tagName !== 'INPUT') return false;
  if (!opts.length) {
    // Async lists (location): type, then pick from what appears.
    fillElement(input, option, 'replace');
    return pickSuggestion(input, option);
  }
  let pick = bestOption(option, opts.map((el) => ({ el, label: textOf(el), value: textOf(el) })));
  if (!pick && input.tagName === 'INPUT') {
    fillElement(input, option, 'replace');
    await sleep(500);
    opts = [...document.querySelectorAll<HTMLElement>('[role=option], [class*="select__option" i]')].filter((o) => isVisible(o));
    pick = bestOption(option, opts.map((el) => ({ el, label: textOf(el), value: textOf(el) })));
  }
  if (!pick) {
    closeCombo(input);
    return false;
  }
  humanClick(pick.el);
  await sleep(300);
  input.setAttribute('data-fp-handled', '1');
  return true;
}

/** A suggestion list that belongs to this text box (Lever's location search, Google Places…). */
function suggestBox(input: HTMLElement): HTMLElement | null {
  // Only boxes that say they search (autocomplete off / aria-autocomplete / a list attribute).
  if (input.getAttribute('autocomplete') !== 'off' && !input.hasAttribute('aria-autocomplete') && !input.hasAttribute('list')) return null;
  const re = /(^|[-_\s])(dropdown|autocomplete|suggest(ions)?|typeahead|results|pac-container)([-_\s]|$)/i;
  let p: HTMLElement | null = input.parentElement;
  for (let i = 0; i < 2 && p; i++, p = p.parentElement) {
    const box = [...p.children].find((c): c is HTMLElement => c !== input && !c.contains(input) && (re.test(c.className.toString()) || c.getAttribute('role') === 'listbox') && !c.querySelector('input, select, textarea'));
    if (box) return box;
    if (p.querySelectorAll('input:not([type=hidden]), select, textarea').length > 1) break;
  }
  return null;
}

/**
 * Text boxes that search as you type and only keep a value picked from their list (Lever's
 * location box clears itself on blur otherwise): type the answer with key events, pick the
 * closest suggestion.
 */
async function pickFromSuggestions(scope: HTMLElement): Promise<SpAnswer[]> {
  const boxes = [...scope.querySelectorAll<HTMLInputElement>('input[type=text], input:not([type])')]
    .filter((i) => isVisible(i) && i.getAttribute('role') !== 'combobox' && !i.hasAttribute('data-fp-handled'))
    .map((input) => ({ input, box: suggestBox(input) }))
    .filter((x): x is { input: HTMLInputElement; box: HTMLElement } => !!x.box);
  if (!boxes.length) return [];
  // A value typed in without picking (or put there by the site's resume reader) doesn't count: those
  // boxes clear themselves on blur. Answer and pick each one.
  // The list's own text ("No location found", "Loading") is not part of the question.
  const labelOf = (x: { input: HTMLInputElement; box: HTMLElement }) => clean(resolveLabel(x.input).replace(textOf(x.box), '').replace(/no (results|location)[^.]*\.?|loading/gi, '')).replace(/\s*[✱*]\s*$/, '');
  const fields = boxes.map((x, i) => {
    const f = extractField(x.input);
    return { id: `s${i + 1}`, field: { ...(f as FieldContext), label: labelOf(x), currentValue: '' } };
  });
  const page = { url: location.href, host: location.hostname, title: document.title, heading: textOf(document.querySelector('h1')), formTitle: '', pageText: deepText(document, 3000), otherFields: [] } as unknown as import('@/lib/types').PageContext;
  const res = await rpc<{ values: Record<string, string>; sources: Record<string, string> }>({ type: 'fill-form', fields, page, engine: 'local' }).catch(() => ({ values: {} as Record<string, string>, sources: {} as Record<string, string> }));
  const out: SpAnswer[] = [];
  for (const [i, { input, box }] of boxes.entries()) {
    const value = res.values[`s${i + 1}`]?.trim();
    input.setAttribute('data-fp-handled', '1'); // the normal fill leaves it alone either way
    if (!value) continue;
    input.focus();
    // Type it with key events, so the site runs its search.
    input.value = '';
    for (const ch of value) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      input.value += ch;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(40);
    }
    let items: HTMLElement[] = [];
    for (let k = 0; k < 16 && !items.length; k++) {
      await sleep(250);
      items = [...box.querySelectorAll<HTMLElement>('*')].filter((x) => isVisible(x) && !x.children.length && textOf(x) && !/no (results|location|match)|loading|try entering/i.test(textOf(x)));
    }
    const pick = bestOption(value, items.map((el) => ({ el, label: textOf(el), value: textOf(el) })));
    const label = labelOf({ input, box });
    if (!pick) {
      log.info(`no suggestion to pick for "${label}" (${JSON.stringify(value)})`);
      continue;
    }
    const target = (pick.el.closest('[class*="dropdown-location" i], [role=option], li') as HTMLElement | null) ?? pick.el;
    for (const t of ['mousedown', 'mouseup'] as const) target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0 }));
    target.click();
    await sleep(300);
    log.info(`✓ "${label}" ← picked "${textOf(pick.el)}" from its suggestions`);
    out.push({ q: label, a: textOf(pick.el), src: res.sources[`s${i + 1}`] ?? 'suggestion list' });
  }
  return out;
}

/**
 * Dropdowns that only list their options once opened (react-select): read each one's options,
 * answer them all through the local model as choices, then pick. Done before the normal fill, which
 * would otherwise type free text into them. Demographic ones get "decline".
 */
async function fillCombos(scope: HTMLElement): Promise<SpAnswer[]> {
  const inputs = [...scope.querySelectorAll<HTMLInputElement>('input[role=combobox], [role=combobox][aria-haspopup=listbox]:not(input)')].filter((i) => isVisible(comboControl(i)) && !i.hasAttribute('data-fp-handled') && !comboChosen(i));
  const out: SpAnswer[] = [];
  const ask: { input: HTMLInputElement; label: string; options: string[]; required: boolean }[] = [];
  for (const input of inputs) {
    const opts = (await comboOptions(input)).map((o) => textOf(o)).filter((t) => t && !/^(no options|loading)/i.test(t));
    closeCombo(input);
    await sleep(150);
    const label = input.tagName === 'INPUT' ? resolveLabel(input) : idsText(input.getAttribute('aria-labelledby')) || clean(input.getAttribute('aria-label')) || questionOf(input);
    if (!opts.length || opts.length > 80) continue; // async (location) or huge lists: the normal fill types into them
    const decline = declineOption(label, opts);
    if (decline) {
      if (await chooseCombo(input, decline)) out.push({ q: label, a: decline, src: 'rule: decline demographic' });
      continue;
    }
    ask.push({ input, label, options: opts, required: isRequired(input, label) });
  }
  if (!ask.length) return out;
  const fields = ask.map((x, i) => ({
    id: `d${i + 1}`,
    field: { fid: `spd${i}`, kind: 'select', inputType: 'select', label: x.label, name: x.input.name, htmlId: x.input.id, placeholder: '', autocomplete: '', description: '', section: '', required: x.required, options: x.options.map((o) => ({ value: o, label: o })), currentValue: '', semantic: classifyField({ label: x.label }), longForm: false } as FieldContext,
  }));
  const page = { url: location.href, host: location.hostname, title: document.title, heading: textOf(document.querySelector('h1')), formTitle: '', pageText: deepText(document, 3000), otherFields: [] } as unknown as import('@/lib/types').PageContext;
  const res = await rpc<{ values: Record<string, string>; sources: Record<string, string> }>({ type: 'fill-form', fields, page, engine: 'local' }).catch(() => ({ values: {} as Record<string, string>, sources: {} as Record<string, string> }));
  for (const [i, x] of ask.entries()) {
    const v = res.values[`d${i + 1}`];
    if (!v?.trim()) continue;
    const ok = await chooseCombo(x.input, v);
    log.info(`${ok ? '✓' : '✗'} "${x.label.slice(0, 80)}" ← ${JSON.stringify(v.slice(0, 60))} (dropdown)`);
    if (ok) out.push({ q: x.label, a: v, src: res.sources[`d${i + 1}`] });
  }
  return out;
}

async function doAction(a: AgentAction, reg: Map<string, Target>): Promise<string> {
  const t = 'id' in a ? reg.get(a.id) : undefined;
  quietFocus(2500);
  switch (a.do) {
    case 'fill': {
      if (!t) return 'unknown field';
      t.el.scrollIntoView?.({ block: 'center' });
      const r = fillElement(t.el, a.value, 'replace', t.label);
      if (r.ok) await pickSuggestion(t.el, r.value);
      t.el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      return r.ok ? '' : 'could not type there';
    }
    case 'choose':
      if (!t) return 'unknown field';
      return (await chooseIn(t, a.option)) ? '' : `no option like "${a.option}"`;
    case 'check':
      if (!t) return 'unknown field';
      if (MARKETING_RE.test(t.label)) return 'not ticking a marketing box';
      if ((t.el as HTMLInputElement).checked || chosen(t.el)) return '';
      humanClick(t.el);
      return '';
    case 'upload':
      if (!t || !(t.el instanceof HTMLInputElement) || t.el.type !== 'file') return 'not a file field';
      if (/cover|photo|portfolio|transcript|id proof/i.test(t.label)) return 'only the resume is uploaded';
      return (await putFile(t.el)) ? '' : 'no resume file saved';
    case 'click':
      if (!t) return 'unknown button';
      t.el.scrollIntoView?.({ block: 'center' });
      humanClick(t.el);
      return '';
    case 'scroll':
      window.scrollBy({ top: innerHeight * 0.8 });
      return '';
    default:
      return '';
  }
}

/**
 * The button that opens this job's application. One "Apply" on the page: that one. Several (a
 * careers page listing roles): the one whose row names this job; none matches → null.
 */
function openButtonFor(title: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>('a, button, [role=button]')].filter((x) => isVisible(x) && OPEN_FORM_RE.test(buttonText(x)));
  if (all.length <= 1) return all[0] ?? null;
  const words = title.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 2 && !/^(the|and|for|with|developer|engineer)$/.test(w));
  if (!words.length) return null;
  let best: { el: HTMLElement; score: number } | null = null;
  for (const el of all) {
    let p: HTMLElement | null = el.parentElement;
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
      const t = textOf(p).toLowerCase();
      if (t.length > 800) break;
      const hit = words.filter((w) => t.includes(w)).length / words.length;
      if (hit >= 0.6 && (!best || hit > best.score)) best = { el, score: hit };
      if (hit >= 0.6) break;
    }
  }
  return best?.el ?? null;
}

// ---------------- the round ----------------

export class SitePilotPage {
  private reg = new Map<string, Target>();
  private answers = new Map<string, SpAnswer>();
  private history: string[] = [];
  private busy = false;

  constructor(private fill: FillFn) {}

  private repairTries = new WeakMap<HTMLElement, number>();

  /** Fix rejected values by rule (digits only, the stated length or range). Returns how many changed. */
  private repairErrors(scope: HTMLElement): number {
    let n = 0;
    for (const e of fieldErrors(scope).filter((x) => x.shown)) {
      const el = e.field as HTMLInputElement;
      if (!(el instanceof HTMLInputElement) || ['radio', 'checkbox', 'file'].includes(el.type)) continue;
      const tries = this.repairTries.get(el) ?? 0;
      if (tries >= 3) continue;
      this.repairTries.set(el, tries + 1);
      const fix = repairValue(el.value, e.msg, specOf(el, e.label), tries);
      if (fix === null || fix === el.value) continue;
      const r = fillElement(el, fix, 'replace', e.label, { exact: true });
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      el.dispatchEvent(new Event('blur'));
      this.progress(`fixed "${e.label.slice(0, 60)}": ${JSON.stringify(fix)} (the site said "${e.msg.slice(0, 60)}")`);
      if (r.ok) n++;
    }
    return n;
  }

  private progress(text: string) {
    log.info(text);
    void chrome.runtime.sendMessage({ type: 'sp-progress', text }).catch(() => {});
  }

  private note(list: SpAnswer[]) {
    for (const a of list) this.answers.set(a.q, a);
  }

  /** Values on the form now, for the record. */
  private collect(scope: HTMLElement, ats: string) {
    const snap = snapshot(scope, this.reg, ats);
    for (const c of snap.controls) {
      if (!c.value || c.kind === 'button' || c.kind === 'link' || !c.label) continue;
      const prev = this.answers.get(c.label);
      this.answers.set(c.label, { q: c.label.slice(0, 200), a: c.kind === 'file' ? `file: ${c.value}` : c.value.slice(0, 600), src: prev?.src ?? 'form' });
    }
  }

  async round(ctx: RoundContext): Promise<RoundResult> {
    if (this.busy) return { kind: 'continue', note: 'round already running' };
    this.busy = true;
    try {
      return await this.run(ctx);
    } catch (e) {
      log.warn('round failed', e);
      return { kind: 'continue', note: `error: ${(e as Error).message}` };
    } finally {
      this.busy = false;
    }
  }

  private result(r: RoundResult, ats: string, actions: number): RoundResult {
    return { ...r, ats, actions, answers: [...this.answers.values()] };
  }

  private async run(ctx: RoundContext): Promise<RoundResult> {
    await settled(document.body, 600, 6000);
    const ats = detectAts(location.href, document.documentElement.outerHTML.slice(0, 200_000));
    let actions = 0;
    const done = (outcome: Extract<RoundResult, { kind: 'done' }>['outcome'], reason: string) => this.result({ kind: 'done', outcome, reason }, ats, actions);

    // After Submit: was it received?
    if (ctx.submitted && confirmed()) {
      await rpc({ type: 'sp-shot', kind: 'confirmation' }).catch(() => null);
      return done('sent', 'the site confirmed the application');
    }
    dismissCookies();
    const text = deepText(document, 20_000);
    let scope = formScope();
    if (!scope) {
      if (CLOSED_RE.test(text.slice(0, 6000))) return done('skipped', 'the job is closed');
      const emb = embeddedForm();
      if (emb) {
        this.progress(`the form is embedded; opening it directly (${emb.slice(0, 80)})`);
        location.href = emb;
        return this.result({ kind: 'continue' }, ats, actions);
      }
      const open = openButtonFor(ctx.title);
      if (!open && !ctx.submitted && ctx.vision && actions < ctx.actionsLeft) {
        // A careers page with several roles (or none labelled "Apply"): the model picks this job's link.
        this.progress(`looking for "${ctx.title}" on this careers page`);
        const snap = snapshot(document.body, this.reg, ats);
        const a = await rpc<AgentAction>({ type: 'sp-agent', snap, history: [...this.history, `find the role "${ctx.title}" and open its application`] }).catch(() => null);
        actions++;
        if (a?.do === 'click' && this.reg.get(a.id)) {
          const el = this.reg.get(a.id)!.el;
          this.history.push(`opened "${buttonText(el).slice(0, 60)}"`);
          humanClick(el);
          await settled(document.body, 800, 8000);
          if (!formScope()) return this.result({ kind: 'continue', note: `opened "${buttonText(el).slice(0, 60)}"` }, ats, actions);
          scope = formScope();
        } else if (a?.do === 'stop') {
          await rpc({ type: 'sp-shot', kind: 'stuck' }).catch(() => null);
          return done('needs-you', a.why || `couldn't find "${ctx.title}" on this careers page`);
        }
      }
      if (!scope && open && !ctx.submitted) {
        this.progress(`pressing "${buttonText(open)}" to open the application form`);
        humanClick(open);
        await settled(document.body, 800, 8000);
        scope = formScope();
        if (!scope) return this.result({ kind: 'continue', note: 'waiting for the form to open' }, ats, actions);
      }
    }
    if (!scope) {
      if (ctx.submitted) {
        // No form any more and no "thank you" text: let the model read the page.
        if (ctx.vision) {
          const a = await rpc<AgentAction>({ type: 'sp-agent', snap: snapshot(document.body, this.reg, ats), history: [...this.history, 'submitted the form'] }).catch(() => null);
          if (a?.do === 'stop' && /confirm/i.test(a.why)) return done('sent', 'the page confirms the application (read from the screenshot)');
        }
        await rpc({ type: 'sp-shot', kind: 'stuck' }).catch(() => null);
        return done('unsure', 'Submit was pressed but no confirmation was seen');
      }
      const why = blockerIn(text) ?? (document.querySelector('input[type=password]') ? 'asks you to sign in' : null);
      await rpc({ type: 'sp-shot', kind: 'stuck' }).catch(() => null);
      return done('needs-you', why ?? 'no application form found on this page');
    }
    if (scope.querySelector('input[type=password]') && isVisible(scope.querySelector('input[type=password]')!)) return done('needs-you', 'asks you to sign in or create an account (password field)');
    if (captchaShown()) {
      await rpc({ type: 'sp-shot', kind: 'stuck' }).catch(() => null);
      return done('needs-you', 'a CAPTCHA has to be solved');
    }
    const blocker = blockerIn(textOf(scope).slice(0, 4000));
    if (blocker && /otp|payment|sign in/.test(blocker)) return done('needs-you', blocker);

    // Fill this page (and each new step of it) once, then look and act.
    const filledSteps = new Set<string>();
    const stepKey = () => snapshot(scope!, this.reg, ats).controls.filter((c) => c.kind !== 'button' && c.kind !== 'link').map((c) => c.label).join('|');
    let lastLook = '';
    let sameLook = 0;
    for (let guard = 0; guard < 40; guard++) {
      if (!scope.isConnected) scope = formScope() ?? document.body;
      const key = stepKey();
      if (!filledSteps.has(key)) {
        filledSteps.add(key);
        this.progress(`filling ${ats === 'other' ? 'the form' : ats} step ${filledSteps.size}`);
        const up = await uploadResume(scope);
        if (up) this.progress(up);
        this.note(fillResumeLink(scope, ctx.resumeLink));
        this.note(await declineDemographics(scope, this.reg));
        this.note(await fillCombos(scope));
        this.note(await pickFromSuggestions(scope));
        const r = await this.fill(scope);
        if (r.error) {
          if (['no-provider', 'unavailable', 'network', 'cors', 'locked', 'timeout'].includes(r.error)) return done('failed', `the local model is not answering (${r.error}); is Ollama running?`);
          this.progress(`fill error: ${r.error}`);
        } else this.progress(`filled ${r.filled} of ${r.total} fields`);
        this.note(await fillCustom(scope));
        this.note(tickConsent(scope));
        await settled(document.body, 500, 3000);
        if (ctx.round === 0 && filledSteps.size === 1) await rpc({ type: 'sp-shot', kind: 'form' }).catch(() => null);
      }
      const snap = snapshot(scope, this.reg, ats);
      const look = JSON.stringify([snap.controls.map((c) => c.value ?? ''), snap.errors, snap.missing]);
      sameLook = look === lastLook ? sameLook + 1 : 0;
      lastLook = look;
      if (sameLook >= 3) {
        await rpc({ type: 'sp-shot', kind: 'stuck' }).catch(() => null);
        this.collect(scope, ats);
        return done('needs-you', `stuck: ${snap.missing.length ? `still missing ${snap.missing.slice(0, 3).join(', ')}` : snap.errors[0] ?? 'nothing changed after 3 tries'}`);
      }

      // Nothing missing, no errors, a Next button: go on without asking the model.
      const next = nextButton(scope);
      const submit = submitButton(scope);
      if (!snap.missing.length && !snap.errors.length && next && !submit) {
        this.collect(scope, ats);
        this.progress(`pressing "${buttonText(next)}"`);
        this.history.push(`pressed ${buttonText(next)}`);
        humanClick(next);
        actions++;
        await settled(document.body, 700, 8000);
        continue;
      }

      // Values the site rejected ("Enter a 10-digit mobile number"): rewrite them without the model first.
      if (snap.errors.length && this.repairErrors(scope)) {
        await settled(document.body, 400, 2000);
        continue;
      }

      let action: AgentAction;
      if (snap.submitReady && submit && !ctx.vision) action = { do: 'submit' };
      else {
        if (actions >= ctx.actionsLeft) return done('needs-you', 'used all its actions on this job; check where it stopped');
        // Put the first problem in view so the screenshot shows it.
        const problem = snap.controls.find((c) => c.error || (c.required && !c.value && c.kind !== 'button'));
        (problem ? this.reg.get(problem.id)?.el : submit)?.scrollIntoView?.({ block: 'center' });
        await sleep(300);
        this.progress(`asking the model (${snap.missing.length} missing, ${snap.errors.length} errors${snap.errors[0] ? `: ${snap.errors[0].slice(0, 100)}` : ''})`);
        action = await rpc<AgentAction>({ type: 'sp-agent', snap, history: this.history }).catch((e) => ({ do: 'stop', why: (e as Error).message }) as AgentAction);
        actions++;
      }

      if (action.do === 'stop') {
        this.collect(scope, ats);
        if (/confirm/i.test(action.why) && confirmed()) return done('sent', 'confirmed');
        await rpc({ type: 'sp-shot', kind: 'stuck' }).catch(() => null);
        if (/local model failed|no usable answer/i.test(action.why)) return done('failed', action.why);
        return done('needs-you', action.why);
      }
      if (action.do === 'next') {
        const n = nextButton(scope);
        if (!n) {
          this.history.push('next: there is no Next button');
          continue;
        }
        this.collect(scope, ats);
        humanClick(n);
        this.history.push(`pressed ${buttonText(n)}`);
        await settled(document.body, 700, 8000);
        continue;
      }
      const clicked = action.do === 'click' ? this.reg.get(action.id) : undefined;
      if (action.do === 'submit' || (clicked && clicked.el === submit)) {
        if (snap.missing.length || snap.errors.length) {
          this.history.push(`submit refused: ${snap.missing.length ? `missing ${snap.missing.slice(0, 3).join(', ')}` : snap.errors[0]}`);
          continue;
        }
        const btn = submit ?? clicked?.el;
        if (!btn) {
          this.history.push('submit: no Submit button found');
          continue;
        }
        this.collect(scope, ats);
        const ok = await rpc<{ allow: 'live' | 'dry' | 'no' }>({ type: 'sp-submit', ats }).catch(() => ({ allow: 'no' as const }));
        await rpc({ type: 'sp-shot', kind: 'before-submit' }).catch(() => null);
        if (ok.allow === 'dry') return done('ready', 'dry run: everything filled and checked, Submit not pressed');
        if (ok.allow === 'no') return done('needs-you', 'Submit was already pressed twice');
        this.progress(`pressing "${buttonText(btn)}"`);
        humanClick(btn);
        actions++;
        // Wait for the confirmation (or the page to change: then the next round checks).
        for (let i = 0; i < 12; i++) {
          await sleep(1000);
          if (confirmed()) {
            await sleep(800);
            await rpc({ type: 'sp-shot', kind: 'confirmation' }).catch(() => null);
            return done('sent', 'the site confirmed the application');
          }
        }
        ctx = { ...ctx, submitted: ctx.submitted + 1 };
        const after = scope.isConnected ? snapshot(scope, this.reg, ats) : null;
        const problems = after ? [...after.errors, ...after.missing.map((m) => `missing: ${m}`)] : [];
        this.progress(`no confirmation after Submit${problems.length ? `; the form shows: ${problems.slice(0, 4).join(' · ')}` : ''}`);
        this.history.push(`pressed Submit; no confirmation yet${problems.length ? ` (${problems.slice(0, 3).join('; ')})` : ''}`);
        if (!scope.isConnected || !isVisible(scope)) return this.result({ kind: 'continue', note: 'submitted; checking the next page' }, ats, actions);
        continue; // errors may have appeared: fix them and try once more
      }
      const err = await doAction(action, this.reg);
      const what = action.do === 'fill' ? `${action.do} ${this.reg.get(action.id)?.label?.slice(0, 50)} = ${action.value.slice(0, 40)}` : action.do === 'choose' ? `choose ${this.reg.get(action.id)?.label?.slice(0, 50)} = ${action.option.slice(0, 40)}` : `${action.do}${'id' in action ? ` ${this.reg.get(action.id)?.label?.slice(0, 50)}` : ''}`;
      this.history.push(err ? `${what} → failed: ${err}` : what);
      if (!err && (action.do === 'fill' || action.do === 'choose')) {
        const t = this.reg.get(action.id);
        if (t) this.answers.set(t.label, { q: t.label, a: action.do === 'fill' ? action.value : action.option, src: 'model (look and act)' });
      }
      await settled(document.body, 500, action.do === 'click' ? 8000 : 2500);
    }
    return done('needs-you', 'too many steps on one page');
  }
}

/**
 * Naukri: press "Apply on company site" and catch the link it opens (a page hook in the main
 * world records window.open / new-tab links while `data-fp-capture-open` is set). The link also
 * survives Naukri moving the tab on, via sessionStorage.
 */
export async function naukriResolve(): Promise<{ url?: string; naukriApply?: boolean; reason?: string; pending?: boolean }> {
  const stored = sessionStorage.getItem('fpOpened');
  if (stored) {
    sessionStorage.removeItem('fpOpened');
    return { url: stored };
  }
  const html = document.documentElement;
  let btn: HTMLElement | null = null;
  for (let i = 0; i < 20 && !btn; i++) {
    btn = document.querySelector<HTMLElement>('#company-site-button') ?? [...document.querySelectorAll<HTMLElement>('button, a')].find((b) => /apply on company site/i.test(textOf(b))) ?? null;
    if (!btn) {
      if ([...document.querySelectorAll<HTMLElement>('#apply-button, button')].some((b) => /^apply$/i.test(textOf(b)) && isVisible(b))) return { naukriApply: true };
      const box = textOf(document.querySelector('.styles_jhc__apply-button-container__5Bqnb, [class*="apply-button-container"]'));
      if (/\balready applied\b|\bapplied\b/i.test(box)) {
        // Applied through Naukri itself: nothing to do. Sent to the company site before (an earlier
        // try): go there again through Naukri's hop.
        const jid = location.pathname.match(/-(\d{9,})(?:[/?#]|$)/)?.[1];
        if (/company|redirect/i.test(box + textOf(document.querySelector('[class*="jhc__"]'))) && jid) return { url: `https://www.naukri.com/cloudgateway-apply/apply-services/v0/apply/saveCompanyApply?id=&file=${jid}&logstr=jdrestapi` };
        return { reason: 'already applied on Naukri' };
      }
      if (/showAcp|myapply/i.test(location.href)) return { reason: 'Naukri did not hand over the company link' };
      await sleep(500);
    }
  }
  if (!btn) return { reason: 'no "Apply on company site" button on the Naukri page' };
  // Naukri's own hop for this job (what the button opens): records the click, then redirects.
  const id = location.pathname.match(/-(\d{9,})(?:[/?#]|$)/)?.[1];
  if (id) return { url: `https://www.naukri.com/cloudgateway-apply/apply-services/v0/apply/saveCompanyApply?id=&file=${id}&logstr=jdrestapi` };
  html.setAttribute('data-fp-capture-open', '1');
  const got = new Promise<string | null>((resolve) => {
    const mo = new MutationObserver(() => {
      const u = html.getAttribute('data-fp-opened');
      if (u) {
        mo.disconnect();
        resolve(u);
      }
    });
    mo.observe(html, { attributes: true, attributeFilter: ['data-fp-opened'] });
    setTimeout(() => (mo.disconnect(), resolve(null)), 12_000);
  });
  humanClick(btn);
  const url = await got;
  html.removeAttribute('data-fp-capture-open');
  if (url) {
    sessionStorage.removeItem('fpOpened');
    return { url };
  }
  return { reason: 'Naukri did not open the company link' };
}
