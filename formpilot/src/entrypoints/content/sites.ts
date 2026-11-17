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
import { buttonByText, jobKey, jobPageState, multiApplyResult, NAUKRI_REC_TABS, naukriMultiApply, naukriRecJobs, sentNotice, sitePushback, type Platform, type RecJob } from '@/lib/sites';
import { titleRelevant, titleSkipped } from '@/lib/queue';
import { classifyField } from '@/lib/fields/classify';
import { extractPage } from '@/lib/fields/context';
import { fillCheckboxGroup, fillElement, fillRadioGroup, bestOption, exactOption } from '@/lib/fields/fill';
import { radioOptionLabel } from '@/lib/fields/radios';
import { emptyRequired } from '@/lib/walk';
import type { FieldContext } from '@/lib/types';
import { extractJob } from '@/lib/job';
import { AI_BLOCKING } from '@/lib/autopilot';

const log = createLogger('autopilot:site');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export interface JobResult {
  outcome: 'sent' | 'dry' | 'skip';
  reason: string;
  pushback?: string;
  /** An outside form the recruiter asked for (handed to Site Pilot). */
  formUrl?: string;
  /** The AI couldn't answer (rate limit, quota…): not a skip, the job is tried again later. */
  aiError?: string;
  answers?: { q: string; a: string }[];
}

/** An AI error worth waiting out (thrown by answerFor / reported by a fill). */
class AiUnavailable extends Error {
  constructor(public code: string) {
    super(`the AI isn't answering (${code})`);
  }
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
  let r: { values: Record<string, string>; sources: Record<string, string> };
  try {
    r = await rpc({ type: 'fill-form', fields: [{ id: 'f1', field }], page, trigger: 'toolbar' });
  } catch (e) {
    const code = (e as { info?: { code?: string } }).info?.code ?? 'unknown';
    if (AI_BLOCKING.has(code)) throw new AiUnavailable(code);
    throw e;
  }
  log.info(`chatbot: "${question.slice(0, 90)}" → "${(r.values.f1 ?? '').slice(0, 60)}"`, { source: r.sources?.f1 ?? '', options });
  return r.values.f1 ?? '';
}

// ------------------------------------------------------------------ Naukri chatbot

function drawer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.chatbot_Drawer, [class*="chatbot_Drawer"]');
}

/** The chatbot's closing lines, not questions. */
const DONE_MSG = /^(thank you|thanks)\b[^?]*$|successfully applied|application (has been )?(sent|submitted)|all the best|we will (get back|reach out)/i;

/** The latest question in the chatbot (the last bot message that isn't the greeting). */
function lastQuestion(d: HTMLElement): string {
  const msgs = [...d.querySelectorAll<HTMLElement>('.botItem .botMsg, [class*="botItem"] [class*="botMsg"]')].map((m) => clean(m.innerText || m.textContent));
  const q = msgs.reverse().find((m) => m && !/^hi\b.*(thank you|kindly answer)/i.test(m));
  return q ?? '';
}

const visible = (el: Element) => (el as HTMLElement).getBoundingClientRect().width > 0;

/** Questions that send you elsewhere (a Google Form, a test link). */
const OUTSIDE_FORM = /https?:\/\/|forms\.gle|docs\.google\.com\/forms|typeform|(fill|complete|submit) (this|the|our|below) (google )?(form|assessment|test)|form \(mandatory\)/i;

/** Chips that aren't answers. */
const SKIP_CHIP = /^(skip( this question)?|skip question|not now|later)$/i;

/** Naukri hides its real radios/checkboxes and shows a <label for> next to them. */
const shown = (r: HTMLInputElement) => visible(r) || [...(r.labels ?? [])].some(visible) || (!!r.closest('label') && visible(r.closest('label')!));
/** A box you can type in, not inside a hidden ("d-none") input bar. */
const typeable = (d: HTMLElement) =>
  [...d.querySelectorAll<HTMLElement>('[contenteditable="true"], textarea, input[type=text]')].find((t) => visible(t) && !t.closest('.d-none, [hidden]')) ?? null;
/** "Which of these locations are you willing to relocate to / work from?": all of them keeps you in. */
const EVERY_OPTION = /\b(willing to (relocate|work|move)|open to (relocat|work)|preferred (work )?locations?|locations? (are you|would you))/i;

async function answerChatbot(d: HTMLElement, q: string, answers: { q: string; a: string }[]): Promise<boolean> {
  const radios = [...d.querySelectorAll<HTMLInputElement>('input[type=radio]')].filter((r) => !r.disabled && shown(r));
  const boxes = [...d.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].filter((r) => !r.disabled && shown(r) && !r.closest('.chatbot_Uploader'));
  // Answer chips, without "Skip this question" (Naukri adds it under typed questions) and
  // without the wrappers around the chips.
  const chips = [...d.querySelectorAll<HTMLElement>('.chatbot_Chip, [class*="chipItem"], [class*="chip" i]:not([class*="chipMsg"]):not([class*="Chips"]):not(.chips):not([class*="chipsContainer"])')]
    .filter((c, _i, all) => visible(c) && clean(c.textContent).length > 0 && clean(c.textContent).length < 80 && !c.closest('.botMsg, .userMsg, [class*="botLogo"]') && !SKIP_CHIP.test(clean(c.textContent)) && !all.some((o) => o !== c && c.contains(o)));
  const text = typeable(d);
  let ok = false;
  let a = '';
  if (radios.length) {
    a = await answerFor(q, 'radio', radios.map((r) => radioOptionLabel(r, radios)));
    ok = fillRadioGroup(radios, a, (x) => radioOptionLabel(x, radios), q).ok;
  } else if (boxes.length) {
    const labels = boxes.map((b) => radioOptionLabel(b, boxes));
    a = EVERY_OPTION.test(q) ? labels.join(' | ') : await answerFor(q, 'checkbox', labels);
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
    // Naukri enables Save on key events, not only input.
    if (ok) for (const type of ['keydown', 'keyup'] as const) text.dispatchEvent(new KeyboardEvent(type, { key: 'Unidentified', bubbles: true }));
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
  return runChatbot(5 * 60_000, 20);
}

/** Answer Naukri's recruiter chatbot until Naukri confirms (or gives up). */
async function runChatbot(ms: number, maxQuestions: number): Promise<JobResult> {
  const answers: { q: string; a: string }[] = [];
  let asked = '';
  let stuck = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(between(0.9, 1.8));
    const push = sitePushback('naukri');
    if (push) return { outcome: 'skip', reason: push, pushback: push, answers };
    if (sentNotice('naukri')) return { outcome: 'sent', reason: 'Naukri confirmed', answers };
    const d = drawer();
    if (!d) continue;
    const q = lastQuestion(d);
    // The bot's sign-off ("Thank you for your responses."): nothing to answer, Naukri applies now.
    if (q && DONE_MSG.test(q)) continue;
    if (!q || q === asked) {
      if (q && ++stuck > 12) return { outcome: 'skip', reason: `the chatbot didn't accept the answer to "${q.slice(0, 60)}"`, answers };
      continue;
    }
    stuck = 0;
    asked = q;
    // "Please fill this Google Form", a link to another site: only you can do that. Never claim it
    // was done; leave the job.
    if (OUTSIDE_FORM.test(q)) {
      // The link goes to Site Pilot, which fills such forms with the local model.
      const link = [...d.querySelectorAll<HTMLAnchorElement>('a[href^="http"]')].map((a) => a.href).filter((h) => !/naukri\.com/i.test(h)).pop() ?? q.match(/https?:\/\/[^\s"'<>)]+|forms\.gle\/[\w-]+/i)?.[0];
      return { outcome: 'skip', reason: `asks you to fill an outside form ("${q.slice(0, 60)}")`, answers, formUrl: link ? (link.startsWith('http') ? link : `https://${link}`) : undefined };
    }
    if (answers.length >= maxQuestions) return { outcome: 'skip', reason: `more than ${maxQuestions} chatbot questions`, answers };
    const ok = await answerChatbot(d, q, answers);
    if (!ok) return { outcome: 'skip', reason: `no answer for "${q.slice(0, 60)}"`, answers };
  }
  return { outcome: 'skip', reason: `Naukri gave no confirmation within ${Math.round(ms / 60_000)} minutes`, answers };
}

// ------------------------------------------------------------------ Naukri "Recommended jobs"

export interface RecPick {
  id: string;
  title: string;
  company: string;
  url: string;
}

export interface RecResult {
  picked: RecPick[];
  outcome: 'sent' | 'dry' | 'skip' | 'none';
  reason: string;
  /** Per job, from Naukri's multiApplyResp (200 = applied). */
  status?: Record<string, number>;
  pushback?: string;
  aiError?: string;
  answers?: { q: string; a: string }[];
}

/**
 * On the Recommended jobs page: go through the tabs, tick up to `max` jobs that fit (your
 * phrases, skip words, years asked, not tried today), press Apply once, answer the chatbot.
 * Dry run: says which it would tick, ticks nothing.
 */
export async function applyNaukriRecommended(opts: { max: number; dryRun: boolean; relevant: string[]; skipWords: string; maxExpMin: number; seen: string[] }): Promise<RecResult> {
  await until(() => naukriRecJobs().length > 0 || !!sitePushback('naukri'), 20_000);
  const push = sitePushback('naukri');
  if (push) return { picked: [], outcome: 'skip', reason: push, pushback: push };
  const seen = new Set(opts.seen);
  const picked: RecJob[] = [];
  const fits = (j: RecJob) =>
    !seen.has(`naukri:${j.id}`) && !seen.has(jobKey(j)) && titleRelevant(j.title, opts.relevant) && !titleSkipped(j.title, opts.skipWords) && (j.expMin === undefined || j.expMin <= opts.maxExpMin) && !picked.some((p) => p.id === j.id || jobKey(p) === jobKey(j));
  const tabs = [...document.querySelectorAll<HTMLElement>('[role=tab], [class*="tab" i]')];
  for (const re of NAUKRI_REC_TABS) {
    if (picked.length >= opts.max) break;
    const tab = tabs.find((t) => re.test(clean(t.innerText || t.textContent)) && visible(t));
    if (tab) {
      humanClick(tab);
      await sleep(between(1.5, 3));
      await until(() => naukriRecJobs().length > 0, 8000);
    }
    const all = naukriRecJobs();
    const fresh = all.filter(fits);
    log.info(`naukri recommended "${clean(tab?.innerText) || 'current'}": ${all.length} jobs, ${fresh.length} fit`, all.map((j) => `${fresh.includes(j) ? '+' : '-'} ${j.title} · ${j.company}${j.expMin !== undefined ? ` · ${j.expMin}+ yrs` : ''}`));
    // One tab per batch: switching tabs redraws the list and drops what was ticked.
    if (fresh.length) {
      picked.push(...fresh.slice(0, opts.max));
      break;
    }
  }
  const out = picked.map((j) => ({ id: j.id, title: j.title, company: j.company, url: j.url }));
  if (!picked.length) return { picked: [], outcome: 'none', reason: 'no recommended job fits' };
  if (opts.dryRun) return { picked: out, outcome: 'dry', reason: `would tick ${picked.length} and press Apply` };
  // Tick them, as a person would, one by one.
  for (const j of picked) {
    if (!j.box.isConnected) continue;
    j.box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(between(0.6, 1.4));
    if (!j.box.checked) humanClick((j.box.closest('label') as HTMLElement | null) ?? j.box);
    await sleep(between(0.4, 1));
  }
  const ticked = picked.filter((j) => j.box.checked);
  const apply = naukriMultiApply();
  if (!ticked.length || !apply || apply.disabled) return { picked: out, outcome: 'skip', reason: "couldn't tick the jobs or the Apply button stayed off" };
  await sleep(between(1, 2.5));
  // Naukri may move to its confirmation page when done, ending this script: tell the autopilot
  // first which jobs were ticked (the confirmation page reports the result).
  await chrome.runtime.sendMessage({ type: 'autopilot-rec-picked', picked: out.filter((p) => ticked.some((t) => t.id === p.id)) }).catch(() => {});
  humanClick(apply);
  let r: JobResult;
  try {
    r = await runChatbot(Math.max(5, picked.length * 3) * 60_000, 15 * picked.length);
  } catch (e) {
    if (!(e instanceof AiUnavailable)) throw e;
    r = { outcome: 'skip', reason: e.message, aiError: e.code };
  }
  const status = multiApplyResult(location.href) ?? undefined;
  const res: RecResult = { picked: out, outcome: r.outcome === 'sent' ? 'sent' : 'skip', reason: r.reason, status, pushback: r.pushback, aiError: r.aiError, answers: r.answers };
  // Record what went through in the job tracker.
  for (const p of out) {
    const ok = status ? status[p.id] === 200 : res.outcome === 'sent';
    if (!ok) continue;
    await rpc({ type: 'tracker-record', kind: 'applied', job: { url: p.url, role: p.title, company: p.company, location: '', source: 'Naukri', salary: '', description: '' }, answers: r.answers ?? [], recordedBy: 'Autopilot naukri' }).catch(() => {});
  }
  return res;
}

// ------------------------------------------------------------------ Cutshort form

function openDialog(): HTMLElement | null {
  const ds = [...document.querySelectorAll<HTMLElement>('[role=dialog], [aria-modal=true], [class*="modal" i], [class*="Modal"]')].filter(visible);
  const d = ds.find((x) => x.querySelector('input, textarea, select, [contenteditable=true]'));
  if (d) return d;
  // Styled-component pop-ups without dialog markup: a fixed layer on top holding form fields.
  return (
    [...document.querySelectorAll<HTMLElement>('body *')].find((e) => {
      const s = getComputedStyle(e);
      return s.position === 'fixed' && Number(s.zIndex) >= 10 && visible(e) && !!e.querySelector('input:not([type=hidden]), textarea, [contenteditable=true]');
    }) ?? null
  );
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

async function applyCutshort(dryRun: boolean, fill: (anchor: HTMLElement) => Promise<{ filled: number; total: number; error?: string }>): Promise<JobResult> {
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
  if (first) {
    const f = await fill(first);
    if (f.error && AI_BLOCKING.has(f.error)) {
      await closeDialog(d);
      return { outcome: 'skip', reason: `the AI isn't answering (${f.error})`, aiError: f.error };
    }
  }
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

// ------------------------------------------------------------------ Foundit

/**
 * Foundit job page: "Quick Apply" in the page header applies on Foundit. It may apply at once,
 * or open recruiter questions in a pop-up (one or more steps). Dry run stops before pressing it,
 * because one click can send. Every pop-up is logged so the first live runs show its shape.
 */
async function applyFoundit(dryRun: boolean, fill: (anchor: HTMLElement) => Promise<{ filled: number; total: number; error?: string }>): Promise<JobResult> {
  const st = jobPageState('foundit');
  if (st.applied) return { outcome: 'skip', reason: 'already applied' };
  if (st.external) return { outcome: 'skip', reason: 'applies on another site ("Apply Now")' };
  if (!st.apply) return { outcome: 'skip', reason: 'no Quick Apply button' };
  if (dryRun) return { outcome: 'dry', reason: 'would press Quick Apply' };
  st.apply.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(between(0.6, 1.2));
  humanClick(st.apply);
  for (let step = 0; step < 6; step++) {
    await until(() => sentNotice('foundit') || !!openDialog() || !!sitePushback('foundit'), 15_000);
    const push = sitePushback('foundit');
    if (push) return { outcome: 'skip', reason: push, pushback: push };
    if (sentNotice('foundit')) return { outcome: 'sent', reason: step ? 'Foundit confirmed after the questions' : 'Foundit applied in one click' };
    const d = openDialog();
    if (!d) return { outcome: 'skip', reason: 'nothing happened after Quick Apply' };
    await sleep(between(1, 2));
    log.info(`foundit: pop-up after Quick Apply (step ${step + 1})`, describeDialog(d));
    const first = d.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select, [contenteditable=true]');
    if (first) {
      const f = await fill(first);
      if (f.error && AI_BLOCKING.has(f.error)) {
        await closeDialog(d);
        return { outcome: 'skip', reason: `the AI isn't answering (${f.error})`, aiError: f.error };
      }
    }
    await sleep(between(0.8, 1.6));
    const missing = emptyRequired(d);
    if (missing.length) {
      await closeDialog(d);
      return { outcome: 'skip', reason: `${missing.length} required question(s) FormPilot couldn't answer` };
    }
    const next = buttonByText(/^(submit|apply|send|submit application|apply now|confirm|done|next|continue|save (and|&) (continue|apply))$/i, d);
    if (!next) {
      log.info('foundit: no button to go on in the pop-up', describeDialog(d));
      await closeDialog(d);
      return { outcome: 'skip', reason: 'the pop-up has no Submit/Next button' };
    }
    humanClick(next);
    await until(() => sentNotice('foundit') || openDialog() !== d || !d.isConnected, 15_000);
    if (sentNotice('foundit')) return { outcome: 'sent', reason: 'Foundit confirmed' };
  }
  return { outcome: 'skip', reason: 'no confirmation after Quick Apply' };
}

/** Apply to the job on this page; reports back to the autopilot. */
export async function applyHere(p: Platform, dryRun: boolean, fill: (anchor: HTMLElement) => Promise<{ filled: number; total: number; error?: string }>): Promise<JobResult> {
  await until(() => !!jobPageState(p).apply || jobPageState(p).applied || jobPageState(p).external || !!sitePushback(p), 15_000);
  const push = sitePushback(p);
  if (push) return { outcome: 'skip', reason: push, pushback: push };
  // Read the job first, as a person would.
  await sleep(between(3, 7));
  const job = extractJob();
  log.info(`${p}: ${dryRun ? 'dry run on' : 'applying to'} ${job.role} at ${job.company}`);
  let r: JobResult;
  try {
    r = p === 'naukri' ? await applyNaukri(dryRun) : p === 'foundit' ? await applyFoundit(dryRun, fill) : await applyCutshort(dryRun, fill);
  } catch (e) {
    if (!(e instanceof AiUnavailable)) throw e;
    // Mid-chatbot on Naukri: the half-done application stays as it is; Naukri keeps it for later.
    r = { outcome: 'skip', reason: e.message, aiError: e.code };
  }
  log.info(`${p}: ${r.outcome} · ${job.role} at ${job.company} · ${r.reason}`, r.answers?.map((x) => `${x.q} → ${x.a}`));
  if (r.outcome === 'sent' || r.outcome === 'dry') {
    await rpc({ type: 'tracker-record', kind: r.outcome === 'sent' ? 'applied' : 'saved', job, answers: r.answers ?? [], recordedBy: r.outcome === 'sent' ? `Autopilot ${p}` : 'Autopilot dry run' }).catch(() => {});
  }
  return r;
}
