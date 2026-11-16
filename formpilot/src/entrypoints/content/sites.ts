/**
 * Autopilot on Naukri and Cutshort: one job page at a time (the background opens each job in
 * the autopilot window and asks this script to apply there).
 *
 *  - Naukri: press Apply; if the recruiter chatbot opens, answer each question (text, choice
 *    chips, radio buttons or checkboxes) with the same answers and rules as forms, press Save,
 *    until Naukri says the application went through.
 *  - Cutshort: press Apply now; fill the application form that opens; press its Apply/Submit.
 *
 * Dry run: Naukri is not pressed (its Apply sends at once when there are no questions);
 * Cutshort's form is opened and filled, then closed without sending.
 */
import { createLogger } from '@/lib/logger';
import { rpc } from '@/lib/messages';
import { humanClick, between } from '@/lib/queue';
import { buttonByText, jobPageState, sentNotice, sitePushback, type Platform } from '@/lib/sites';
import { classifyField } from '@/lib/fields/classify';
import { extractPage } from '@/lib/fields/context';
import { fillCheckboxGroup, fillElement, fillRadioGroup, bestOption, exactOption } from '@/lib/fields/fill';
import { radioOptionLabel } from '@/lib/fields/radios';
import { emptyRequired } from '@/lib/walk';
import type { FieldContext } from '@/lib/types';
import { extractJob } from '@/lib/job';

const log = createLogger('autopilot:site');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export interface JobResult {
  outcome: 'sent' | 'dry' | 'skip';
  reason: string;
  pushback?: string;
  answers?: { q: string; a: string }[];
}

async function until(cond: () => boolean, ms: number, every = 400) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(every);
  }
  return cond();
}

/** Ask FormPilot's answer engine (memory, facts, rules, then the AI) for one question. */
async function answerFor(question: string, kind: 'text' | 'radio' | 'checkbox' | 'select', options: string[] = []): Promise<string> {
  const field: FieldContext = {
    fid: `ap-${Date.now()}`,
    kind: options.length ? 'select' : 'input',
    inputType: options.length ? kind : 'text',
    label: question,
    name: '',
    htmlId: '',
    placeholder: '',
    autocomplete: '',
    description: '',
    section: '',
    required: true,
    options: options.map((o) => ({ value: o, label: o })),
    currentValue: '',
    semantic: classifyField({ label: question, name: '' }),
    longForm: false,
    chat: !options.length,
  };
  const page = extractPage(document.body, { pageChars: 1500, otherFields: false, sendUrl: false });
  const r = await rpc<{ values: Record<string, string>; sources: Record<string, string> }>({ type: 'fill-form', fields: [{ id: 'q', field }], page, trigger: 'toolbar' });
  log.info(`chatbot: "${question.slice(0, 90)}" → "${(r.values.q ?? '').slice(0, 60)}"`, { source: r.sources?.q ?? '', options });
  return r.values.q ?? '';
}

// ------------------------------------------------------------------ Naukri chatbot

function drawer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.chatbot_Drawer, [class*="chatbot_Drawer"]');
}

/** The latest question in the chatbot (the last bot message that isn't the greeting). */
function lastQuestion(d: HTMLElement): string {
  const msgs = [...d.querySelectorAll<HTMLElement>('.botItem .botMsg, [class*="botItem"] [class*="botMsg"]')].map((m) => clean(m.innerText || m.textContent));
  const q = msgs.reverse().find((m) => m && !/^hi\b.*(thank you|kindly answer)/i.test(m));
  return q ?? '';
}

const visible = (el: Element) => (el as HTMLElement).getBoundingClientRect().width > 0;

async function answerChatbot(d: HTMLElement, q: string, answers: { q: string; a: string }[]): Promise<boolean> {
  const radios = [...d.querySelectorAll<HTMLInputElement>('input[type=radio]')].filter((r) => !r.disabled && (visible(r) || visible(r.closest('label') ?? r)));
  const boxes = [...d.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].filter((r) => !r.disabled && (visible(r) || visible(r.closest('label') ?? r)));
  const chips = [...d.querySelectorAll<HTMLElement>('[class*="chip" i]:not([class*="chipMsg"])')].filter((c) => visible(c) && clean(c.textContent).length > 0 && clean(c.textContent).length < 80 && !c.closest('.botMsg, .userMsg, [class*="botLogo"]'));
  const text = d.querySelector<HTMLElement>('[contenteditable="true"], textarea, input[type=text]');
  let ok = false;
  let a = '';
  if (radios.length) {
    a = await answerFor(q, 'radio', radios.map((r) => radioOptionLabel(r, radios)));
    ok = fillRadioGroup(radios, a, (x) => radioOptionLabel(x, radios), q).ok;
  } else if (boxes.length) {
    a = await answerFor(q, 'checkbox', boxes.map((b) => radioOptionLabel(b, boxes)));
    ok = fillCheckboxGroup(boxes, a, (x) => radioOptionLabel(x, boxes)).ok;
  } else if (chips.length) {
    const opts = chips.map((c) => ({ value: clean(c.textContent), label: clean(c.textContent), c }));
    a = await answerFor(q, 'select', opts.map((o) => o.label));
    const m = exactOption(a, opts) ?? bestOption(a, opts);
    if (m) {
      humanClick(m.c);
      ok = true;
    }
  } else if (text) {
    a = await answerFor(q, 'text');
    if (a) ok = fillElement(text, a, 'replace', q).ok;
  }
  if (!ok) {
    log.info(`chatbot: no usable answer for "${q.slice(0, 90)}"`);
    return false;
  }
  answers.push({ q, a });
  await sleep(between(0.6, 1.4));
  const save = d.querySelector<HTMLElement>('.sendMsg') ?? buttonByText(/^(save|send|submit|next|done)$/i, d);
  if (save) humanClick(save);
  return true;
}

async function applyNaukri(dryRun: boolean): Promise<JobResult> {
  const st = jobPageState('naukri');
  if (st.applied) return { outcome: 'skip', reason: 'already applied' };
  if (st.external) return { outcome: 'skip', reason: 'applies on the company site' };
  if (!st.apply) return { outcome: 'skip', reason: 'no Apply button' };
  // Naukri sends at once when the recruiter asked no questions, so a dry run stops here.
  if (dryRun) return { outcome: 'dry', reason: 'would press Apply' };
  humanClick(st.apply);
  const answers: { q: string; a: string }[] = [];
  let asked = '';
  let stuck = 0;
  const end = Date.now() + 5 * 60_000;
  while (Date.now() < end) {
    await sleep(1200);
    const push = sitePushback('naukri');
    if (push) return { outcome: 'skip', reason: push, pushback: push, answers };
    if (sentNotice('naukri')) return { outcome: 'sent', reason: 'Naukri confirmed', answers };
    const d = drawer();
    if (!d) continue;
    const q = lastQuestion(d);
    if (!q || q === asked) {
      if (q && ++stuck > 12) return { outcome: 'skip', reason: `the chatbot didn't accept the answer to "${q.slice(0, 60)}"`, answers };
      continue;
    }
    stuck = 0;
    asked = q;
    if (answers.length >= 20) return { outcome: 'skip', reason: 'more than 20 chatbot questions', answers };
    const ok = await answerChatbot(d, q, answers);
    if (!ok) return { outcome: 'skip', reason: `no answer for "${q.slice(0, 60)}"`, answers };
  }
  return { outcome: 'skip', reason: 'Naukri gave no confirmation within 5 minutes', answers };
}

// ------------------------------------------------------------------ Cutshort form

function openDialog(): HTMLElement | null {
  const ds = [...document.querySelectorAll<HTMLElement>('[role=dialog], [aria-modal=true], [class*="modal" i], [class*="Modal"]')].filter(visible);
  return ds.find((d) => d.querySelector('input, textarea, select, button')) ?? null;
}

function describeDialog(d: HTMLElement) {
  const fields = [...d.querySelectorAll<HTMLElement>('input, textarea, select, [contenteditable=true]')]
    .filter(visible)
    .map((f) => `${f.tagName.toLowerCase()}/${(f as HTMLInputElement).type || ''} "${clean(f.getAttribute('aria-label') || (f as HTMLInputElement).placeholder || (f as HTMLInputElement).name).slice(0, 60)}"`);
  const buttons = [...d.querySelectorAll<HTMLElement>('button')].filter(visible).map((b) => clean(b.textContent).slice(0, 40));
  return { text: clean(d.innerText).slice(0, 600), fields, buttons };
}

async function closeDialog(d: HTMLElement) {
  const x = [...d.querySelectorAll<HTMLElement>('button, [role=button]')].find((b) => /close|dismiss|cancel/i.test(`${b.getAttribute('aria-label') ?? ''} ${clean(b.textContent)}`));
  if (x) humanClick(x);
  else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !openDialog(), 4000);
}

async function applyCutshort(dryRun: boolean, fill: (anchor: HTMLElement) => Promise<{ filled: number; total: number }>): Promise<JobResult> {
  const st = jobPageState('cutshort');
  if (st.applied) return { outcome: 'skip', reason: 'already applied' };
  if (!st.apply) return { outcome: 'skip', reason: 'no Apply button' };
  humanClick(st.apply);
  // Either a form opens, or Cutshort applies straight away (one-click apply).
  await until(() => !!openDialog() || sentNotice('cutshort'), 10_000);
  const push = sitePushback('cutshort');
  if (push) return { outcome: 'skip', reason: push, pushback: push };
  if (!openDialog()) {
    if (sentNotice('cutshort')) {
      if (dryRun) log.warn('dry run: Cutshort applied in one click (no form). Turn Cutshort dry run off only if that is OK.');
      return { outcome: 'sent', reason: 'one-click apply' };
    }
    return { outcome: 'skip', reason: 'no application form opened' };
  }
  const d = openDialog()!;
  await sleep(between(1, 2));
  const first = d.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select, [contenteditable=true]');
  if (first) await fill(first);
  await sleep(between(0.8, 1.6));
  const info = describeDialog(d);
  log.info('cutshort: application form', info);
  const missing = emptyRequired(d);
  const submit = buttonByText(/^(apply|submit|send|submit application|send application|apply now|confirm)$/i, d);
  if (missing.length) {
    await closeDialog(d);
    return { outcome: 'skip', reason: `${missing.length} required field(s) FormPilot couldn't answer` };
  }
  if (!submit) {
    await closeDialog(d);
    return { outcome: 'skip', reason: 'no Apply/Submit button in the form' };
  }
  if (dryRun) {
    await closeDialog(d);
    return { outcome: 'dry', reason: `form filled; would press "${clean(submit.textContent)}"` };
  }
  humanClick(submit);
  const ok = await until(() => sentNotice('cutshort') || !openDialog(), 20_000);
  return ok && (sentNotice('cutshort') || !openDialog()) ? { outcome: 'sent', reason: 'Cutshort confirmed' } : { outcome: 'skip', reason: 'no confirmation after Apply' };
}

/** Apply to the job on this page; reports back to the autopilot. */
export async function applyHere(p: Platform, dryRun: boolean, fill: (anchor: HTMLElement) => Promise<{ filled: number; total: number }>): Promise<JobResult> {
  await until(() => !!jobPageState(p).apply || jobPageState(p).applied || jobPageState(p).external || !!sitePushback(p), 15_000);
  const push = sitePushback(p);
  if (push) return { outcome: 'skip', reason: push, pushback: push };
  // Read the job first, as a person would.
  await sleep(between(3, 7));
  const job = extractJob();
  log.info(`${p}: ${dryRun ? 'dry run on' : 'applying to'} ${job.role} at ${job.company}`);
  const r = p === 'naukri' ? await applyNaukri(dryRun) : await applyCutshort(dryRun, fill);
  log.info(`${p}: ${r.outcome} · ${job.role} at ${job.company} · ${r.reason}`, r.answers?.map((x) => `${x.q} → ${x.a}`));
  if (r.outcome === 'sent' || r.outcome === 'dry') {
    await rpc({ type: 'tracker-record', kind: r.outcome === 'sent' ? 'applied' : 'saved', job, answers: r.answers ?? [], recordedBy: r.outcome === 'sent' ? `Autopilot ${p}` : 'Autopilot dry run' }).catch(() => {});
  }
  return r;
}
