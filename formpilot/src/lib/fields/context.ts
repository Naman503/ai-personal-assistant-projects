/**
 * Extract a compact, LLM-friendly description of a form field from the DOM.
 *
 * Label resolution order (most → least reliable):
 *   aria-labelledby → <label for> → wrapping <label> → aria-label → title
 *   → preceding sibling / table-cell / grid text → placeholder → name/id.
 */

import type { FieldContext, FieldKind, FieldOption, PageContext } from '../types';
import { classifyField, isFactual, isSensitive, splitIdent } from './classify';
import { collapseWs, truncate, uid } from '../util';

export type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'number', 'search', 'date', 'datetime-local', 'month', 'week', 'time']);

export const FID_ATTR = 'data-formpilot-id';

export function fieldKind(el: Element): FieldKind | null {
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLSelectElement) return 'select';
  if (el instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(el.type.toLowerCase()) || el.type === 'password' ? 'input' : null;
  }
  if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable';
  return null;
}

/** Walk up from a node inside a contenteditable to the editable root. */
export function editableRoot(el: HTMLElement): HTMLElement {
  let cur: HTMLElement = el;
  while (cur.parentElement && cur.parentElement.isContentEditable) cur = cur.parentElement;
  return cur;
}

export function getFid(el: Element): string {
  let id = el.getAttribute(FID_ATTR);
  if (!id) {
    id = uid('f');
    el.setAttribute(FID_ATTR, id);
  }
  return id;
}

/** Text of an element with scripts/styles/our own UI and hidden nodes removed. */
export function visibleText(el: Element | null | undefined, max = 300): string {
  if (!el) return '';
  // innerText respects CSS visibility, but happy-dom/jsdom don't implement it; fall back to textContent.
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? '';
  return truncate(collapseWs(raw || el.textContent || ''), max);
}

function textOfIds(root: Document | ShadowRoot, ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => (id ? root.getElementById?.(id) ?? (root as Document).querySelector?.(`#${CSS.escape(id)}`) : null))
    .filter(Boolean)
    .map((n) => visibleText(n as Element, 200))
    .join(' ')
    .trim();
}

function rootOf(el: Element): Document | ShadowRoot {
  const r = el.getRootNode();
  return r instanceof ShadowRoot || r instanceof Document ? r : document;
}

/** Text of a label element excluding the text of the control nested inside it (e.g. select options). */
function labelText(label: HTMLLabelElement): string {
  const clone = label.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input,select,textarea,button,[contenteditable]').forEach((n) => n.remove());
  return collapseWs(clone.textContent ?? '');
}

function closestAcrossShadow(el: Element, selector: string): Element | null {
  let cur: Element | null = el;
  while (cur) {
    const found = cur.closest(selector);
    if (found) return found;
    const root = cur.getRootNode();
    cur = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

/** Text immediately before the field in reading order: sibling text, parent's preceding text, table header… */
function nearbyText(el: Element): string {
  // Table layouts: <td>Label</td><td><input></td>, or a header row.
  const cell = el.closest('td,th');
  if (cell) {
    const prev = cell.previousElementSibling;
    if (prev) {
      const t = visibleText(prev, 150);
      if (t) return t;
    }
  }
  // Walk up a few levels; at each level look at previous siblings for short text.
  let cur: Element | null = el;
  for (let depth = 0; depth < 4 && cur; depth++) {
    let sib = cur.previousElementSibling;
    let hops = 0;
    while (sib && hops < 3) {
      if (!sib.matches('input,select,textarea,button,script,style,[hidden]') && !sib.querySelector('input,select,textarea')) {
        const t = visibleText(sib, 200);
        if (t && t.length < 200) return t;
      }
      sib = sib.previousElementSibling;
      hops++;
    }
    // Text nodes directly preceding inside the parent (e.g. "Name: <input>")
    const parent: HTMLElement | null = cur.parentElement;
    if (parent) {
      let n: ChildNode | null = cur.previousSibling;
      while (n) {
        if (n.nodeType === Node.TEXT_NODE) {
          const t = collapseWs(n.textContent ?? '');
          if (t) return truncate(t, 150);
        }
        n = n.previousSibling;
      }
    }
    cur = parent;
    if (cur && cur.matches('form,fieldset,body')) break;
  }
  return '';
}

function sectionText(el: Element): string {
  const fs = el.closest('fieldset');
  const legend = fs?.querySelector('legend');
  if (legend) return visibleText(legend, 120);
  // Nearest preceding heading within the form/container.
  const container = el.closest('form,[role=form],section,main,article,div[class*="section" i]') ?? el.parentElement;
  if (!container) return '';
  const headings = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]'));
  let best: Element | null = null;
  for (const h of headings) {
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
    else break;
  }
  return best ? visibleText(best, 120) : '';
}

function describeOptions(el: HTMLSelectElement): FieldOption[] {
  return Array.from(el.options)
    .filter((o) => !o.disabled)
    .map((o) => ({ value: o.value, label: collapseWs(o.label || o.text) }))
    .filter((o) => o.label || o.value)
    .slice(0, 200);
}

export function readValue(el: FillableElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.label ?? el.value;
  return collapseWs((el as HTMLElement).innerText ?? el.textContent ?? '');
}

export function resolveLabel(el: FillableElement): string {
  const root = rootOf(el);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const t = textOfIds(root, labelledBy);
    if (t) return t;
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) {
    const t = Array.from(labels)
      .map((l) => labelText(l))
      .filter(Boolean)
      .join(' ');
    if (t) return t;
  } else if (el.id) {
    // `.labels` is unreliable for elements inside shadow roots / custom elements.
    const l = (root as Document).querySelector?.(`label[for="${CSS.escape(el.id)}"]`);
    if (l) {
      const t = labelText(l as HTMLLabelElement);
      if (t) return t;
    }
  }
  const wrap = el.closest('label');
  if (wrap) {
    const t = labelText(wrap);
    if (t) return t;
  }
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return collapseWs(aria);
  const title = el.getAttribute('title');
  if (title?.trim()) return collapseWs(title);
  const near = nearbyText(el);
  if (near) return near;
  const ph = el.getAttribute('placeholder') ?? el.getAttribute('aria-placeholder') ?? el.getAttribute('data-placeholder');
  if (ph?.trim()) return collapseWs(ph);
  const nm = el.getAttribute('name') || el.id;
  return nm ? collapseWs(splitIdent(nm)) : '';
}

function describeHelp(el: Element): string {
  const root = rootOf(el);
  const parts: string[] = [];
  const by = el.getAttribute('aria-describedby');
  if (by) parts.push(textOfIds(root, by));
  const hint = el.parentElement?.querySelector(
    '[class*="hint" i],[class*="help" i],[class*="description" i],small,[id$=-help],[id$=-hint]',
  );
  if (hint && hint !== el) parts.push(visibleText(hint, 200));
  return truncate(collapseWs(Array.from(new Set(parts.filter(Boolean))).join(' · ')), 300);
}

/** Labels that say nothing about the question ("Type message here…"). */
const GENERIC_LABEL = /^(please\s+)?((type|write|enter|add|send)\s+)?((a|an|your)\s+)?(message|reply|answer|response|text|comment|chat)s?(\s+here)?\s*[.…]*$|^type here|^ask (me )?anything|^start typing/i;

export function isGenericLabel(label: string): boolean {
  return !label.trim() || GENERIC_LABEL.test(label.trim());
}

const MODAL_SEL = 'dialog,[role=dialog],[role=alertdialog],[aria-modal=true],[class*="modal" i],[class*="drawer" i],[class*="chatbot" i],[class*="chat" i],[class*="popup" i]';

/** Nearest dialog / drawer / chat container around a field (crossing shadow roots). */
/** Ancestors (innermost → outermost, crossing shadow roots) that form a floating layer: drawers, popups, chat widgets. */
export function floatingAncestors(el: Element): Element[] {
  const out: Element[] = [];
  const view = el.ownerDocument.defaultView;
  let cur: Element | null = el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null);
  while (cur && cur !== el.ownerDocument.body && cur !== el.ownerDocument.documentElement) {
    const cs = view?.getComputedStyle(cur);
    const z = Number(cs?.zIndex);
    if (cs && (cs.position === 'fixed' || (cs.position === 'absolute' && z >= 100))) out.push(cur);
    const next: Element | null = cur.parentElement ?? (cur.getRootNode() instanceof ShadowRoot ? (cur.getRootNode() as ShadowRoot).host : null);
    cur = next;
  }
  return out;
}

/**
 * The popup/drawer/chat layer a field lives in: an explicit dialog first, else the innermost
 * fixed-position (or high z-index absolute) ancestor. Works even when the site uses no ARIA.
 */
export function overlayRoot(el: Element): Element | null {
  return closestAcrossShadow(el, 'dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]') ?? floatingAncestors(el)[0] ?? null;
}

export function modalContainer(el: Element): Element | null {
  return closestAcrossShadow(el, MODAL_SEL) ?? overlayRoot(el);
}

export interface ConversationInfo {
  text: string;
  /** The element holding the latest question (the chat bubble). */
  block: Element | null;
  /** Which strategy found it (for diagnostics). */
  via?: 'site' | 'visual' | 'dom';
}

/**
 * Known chat-questionnaire widgets. Selectors come from Naukri's real drawer markup
 * (documented by several open-source Naukri automation projects):
 *   .chatbot_DrawerContentWrapper > .chatbot_MessageContainer > ul.list > li.botItem > .botMsg
 * The LAST visible .botMsg is the current question; the first is a "Hi …, kindly answer…" greeting.
 */
export const SITE_PROFILES: { host: string; container: string; question: string; greeting?: RegExp }[] = [
  {
    host: 'naukri.com',
    container: '.chatbot_DrawerContentWrapper, [class*="chatbot_Drawer"], ._chatBotContainer',
    question: 'li.botItem .botMsg, .chatbot_MessageContainer .botMsg',
    greeting: /^(hi|hello)\b.*(thank you for showing interest|kindly answer)|^kindly answer all/i,
  },
];

/** A profile applies on its site, or anywhere the field sits inside that widget's (very specific) markup. */
function profileFor(el: Element) {
  const host = el.ownerDocument.location?.hostname ?? '';
  return SITE_PROFILES.find((p) => host === p.host || host.endsWith('.' + p.host) || !!el.closest(p.container));
}

/** 1) Site profile: read the widget's own message bubbles. */
function siteQuestion(el: Element): ConversationInfo | null {
  const prof = profileFor(el);
  if (!prof) return null;
  const scope: ParentNode = el.closest(prof.container) ?? el.ownerDocument;
  const bubbles = Array.from(scope.querySelectorAll(prof.question)).filter((b) => isVisible(b) && collapseWs((b as HTMLElement).innerText ?? b.textContent).length > 0);
  const last = bubbles.at(-1);
  if (!last) return null;
  const text = collapseWs((last as HTMLElement).innerText ?? last.textContent ?? '');
  if (prof.greeting?.test(text) && bubbles.length === 1) return { text: '', block: last, via: 'site' };
  return { text: truncate(text, 300), block: last, via: 'site' };
}

/**
 * 2) Visual: probe the screen straight above the input with elementsFromPoint and collect
 * the nearest text blocks. Independent of DOM order, class names or CSS layout tricks.
 */
function visualQuestion(el: Element): ConversationInfo {
  const doc = el.ownerDocument;
  const r = el.getBoundingClientRect();
  if (!r.width || typeof doc.elementsFromPoint !== 'function') return { text: '', block: null, via: 'visual' };
  const xs = [r.left + Math.min(48, r.width / 4), r.left + r.width / 2];
  const seen = new Set<Element>();
  const texts = new Set<string>();
  const blocks: { el: Element; text: string }[] = [];
  for (let y = r.top - 6; y > Math.max(0, r.top - 700) && blocks.length < 6; y -= 8) {
    for (const x of xs) {
      for (const hit of doc.elementsFromPoint(x, y)) {
        if (hit.tagName === 'FORMPILOT-UI' || hit === doc.body || hit === doc.documentElement) continue;
        if (hit.contains(el)) break; // a container of the input: nothing useful deeper at this point
        if (seen.has(hit)) break;
        const t = collapseWs((hit as HTMLElement).innerText ?? hit.textContent ?? '');
        if (!t) continue; // empty wrapper: look at what's under it
        if (t.length > 500) break; // a big container, not a message
        // Probing the gap between bubbles hits their shared container: skip it, a message is a leaf-ish block.
        const textKids = Array.from(hit.children).filter((c) => collapseWs((c as HTMLElement).innerText ?? c.textContent ?? '')).length;
        if (textKids > 1) break;
        seen.add(hit);
        if (!texts.has(t)) {
          texts.add(t);
          blocks.push({ el: hit, text: t });
        }
        break;
      }
    }
  }
  const pick = blocks.slice(0, 4).find((b) => b.text.includes('?')) ?? blocks[0];
  return pick ? { text: truncate(pick.text, 300), block: pick.el, via: 'visual' } : { text: '', block: null, via: 'visual' };
}

const BLOCK_SEL = 'p,li,div,span,section,article,h1,h2,h3,h4,td';
const SKIP_SEL = 'button,script,style,noscript,[aria-hidden=true],[hidden],formpilot-ui,select,option,textarea,input';

/** 3) DOM: walk backwards in document order from the field (bounded: 400 text nodes / 8 blocks). */
function domQuestion(el: Element): ConversationInfo {
  const root = el.getRootNode() as Document | ShadowRoot;
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(root instanceof ShadowRoot ? root : doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
  walker.currentNode = el;
  const blocks: { el: Element; text: string }[] = [];
  let seen = 0;
  for (let n = walker.previousNode(); n && seen < 400 && blocks.length < 8; n = walker.previousNode(), seen++) {
    const t = collapseWs(n.textContent ?? '');
    const parent = n.parentElement;
    if (!t || !parent || parent.closest(SKIP_SEL) || el.contains(n)) continue;
    if (parent instanceof HTMLElement && !isVisible(parent)) continue;
    const block = parent.closest(BLOCK_SEL) ?? parent;
    const last = blocks[blocks.length - 1];
    if (last && last.el === block) last.text = `${t} ${last.text}`;
    else blocks.push({ el: block, text: t });
  }
  const q = blocks.find((b) => b.text.includes('?'));
  const pick = q ?? blocks[0];
  return pick ? { text: truncate(pick.text, 300), block: pick.el, via: 'dom' } : { text: '', block: null, via: 'dom' };
}

/**
 * The question a chat-style questionnaire is currently asking: the latest bot message above the input.
 * Tries the site profile, then what is visually above the input, then document order.
 */
export function conversationQuestionInfo(el: Element): ConversationInfo {
  const site = siteQuestion(el);
  if (site) return site; // the widget is known: trust it (empty text = only the greeting so far)
  const visual = visualQuestion(el);
  if (visual.text.includes('?')) return visual;
  const dom = domQuestion(el);
  if (dom.text.includes('?')) return dom;
  return visual.text ? visual : dom;
}

/** All strategies, for the diagnostics log. */
export function conversationDiagnostics(el: Element) {
  const short = (i: ConversationInfo | null) => (i ? { text: truncate(i.text, 120), block: i.block ? describeAncestors(i.block, 3) : null } : null);
  return { site: short(siteQuestion(el)), visual: short(visualQuestion(el)), dom: short(domQuestion(el)) };
}

/** Is the latest message a real question we can answer (not empty, not just the greeting)? */
export function questionReady(info: ConversationInfo): boolean {
  if (!info.text.trim()) return false;
  return info.via === 'site' || info.text.trim().endsWith('?') || info.text.includes('?');
}

export function conversationQuestion(el: Element): string {
  return conversationQuestionInfo(el).text;
}

/** Lowest element containing both nodes (same tree only), or null if it is just <body>/<html>. */
export function lowestCommonAncestor(a: Element, b: Element): Element | null {
  const set = new Set<Element>();
  for (let cur: Element | null = a; cur; cur = cur.parentElement) set.add(cur);
  for (let cur: Element | null = b; cur; cur = cur.parentElement) {
    if (set.has(cur)) return cur === a.ownerDocument.body || cur === a.ownerDocument.documentElement ? null : cur;
  }
  return null;
}

/** "div.chatbot_Drawer[fixed z1001] > div.x > …": compact ancestor chain for diagnostics. */
export function describeAncestors(el: Element, max = 8): string {
  const view = el.ownerDocument.defaultView;
  const parts: string[] = [];
  for (let cur: Element | null = el, i = 0; cur && i < max && cur !== el.ownerDocument.body; cur = cur.parentElement, i++) {
    const cs = view?.getComputedStyle(cur);
    const cls = typeof cur.className === 'string' ? cur.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const role = cur.getAttribute('role');
    const pos = cs && cs.position !== 'static' ? `${cs.position}${cs.zIndex !== 'auto' ? ' z' + cs.zIndex : ''}` : '';
    parts.push(`${cur.tagName.toLowerCase()}${cur.id ? '#' + cur.id : ''}${cls ? '.' + cls : ''}${role ? `[role=${role}]` : ''}${pos ? `[${pos}]` : ''}`);
  }
  return parts.join(' < ');
}

export function extractField(el: FillableElement, opts: { chat?: boolean } = {}): FieldContext | null {
  const kind = fieldKind(el);
  if (!kind) return null;
  const input = el as HTMLInputElement;
  const inputType = kind === 'input' ? (input.type || 'text').toLowerCase() : kind;
  let label = truncate(resolveLabel(el), 300);
  const placeholder = collapseWs(el.getAttribute('placeholder') ?? el.getAttribute('aria-placeholder') ?? el.getAttribute('data-placeholder') ?? '');
  let chat = false;
  // Chat-style questionnaire: forced (chat site), generic label, or a generic placeholder inside a modal/drawer/chat widget.
  if (opts.chat || isGenericLabel(label) || (placeholder && isGenericLabel(placeholder) && (label === placeholder || modalContainer(el)))) {
    const q = conversationQuestion(el);
    if (q) {
      label = q;
      chat = true;
    }
  }
  const name = el.getAttribute('name') ?? '';
  const htmlId = el.id ?? '';
  const autocomplete = el.getAttribute('autocomplete') ?? '';
  const ml = Number(el.getAttribute('maxlength'));
  const semantic = classifyField({ inputType, autocomplete, label, name, htmlId, placeholder });

  const longForm =
    !chat &&
    (kind === 'textarea' ||
    kind === 'contenteditable' ||
    ['cover-letter', 'summary', 'motivation'].includes(semantic) ||
    (!isFactual(semantic) && label.split(' ').length > 9 && !(ml > 0 && ml < 120)));

  return {
    fid: getFid(el),
    kind,
    inputType,
    label,
    name,
    htmlId,
    placeholder,
    autocomplete,
    description: describeHelp(el),
    section: sectionText(el),
    maxLength: ml > 0 && ml < 1_000_000 ? ml : undefined,
    required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
    options: el instanceof HTMLSelectElement ? describeOptions(el) : undefined,
    currentValue: truncate(readValue(el), 2000),
    semantic,
    longForm,
    chat: chat || undefined,
  };
}

/** Short constraint string for the prompt: pattern, min/max, step. */
export function describeConstraints(el: Element): string {
  const parts: string[] = [];
  for (const a of ['pattern', 'min', 'max', 'step', 'minlength', 'inputmode']) {
    const v = el.getAttribute(a);
    if (v) parts.push(`${a}=${v}`);
  }
  return parts.join(', ');
}

/** The form (or document body) that contains an element, crossing shadow boundaries. */
export function formOf(el: Element): Element {
  return closestAcrossShadow(el, 'form,[role=form]') ?? el.ownerDocument.body;
}

/** Visible radio buttons in the same form, grouped by name. */
export function radioGroups(el: Element): Map<string, HTMLInputElement[]> {
  const groups = new Map<string, HTMLInputElement[]>();
  for (const r of formOf(el).querySelectorAll<HTMLInputElement>('input[type=radio]')) {
    if (r.disabled || !isVisible(r)) continue;
    const k = r.name || r.id;
    if (!k) continue;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return groups;
}

/** All fillable fields in the same form (or the whole document if not in a form). */
export function siblingFields(el: Element): FillableElement[] {
  const form = formOf(el);
  return Array.from(form.querySelectorAll<FillableElement>('input,textarea,select,[contenteditable=""],[contenteditable=true]')).filter(
    (f) => fieldKind(f) && isVisible(f),
  );
}

export function isVisible(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.hidden || h.closest('[hidden],[aria-hidden=true],[inert]')) return false;
  if ((el as HTMLInputElement).type === 'hidden') return false;
  if (typeof h.checkVisibility === 'function') {
    return h.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true } as CheckVisibilityOptions);
  }
  const r = h.getBoundingClientRect?.();
  return !r || r.width > 0 || r.height > 0;
}

/** Main readable text of the page, skipping nav/footer/forms, for grounding (job descriptions etc.). */
export function pageMainText(doc: Document, max: number): string {
  if (max <= 0) return '';
  const main =
    doc.querySelector('main,[role=main],article') ??
    doc.querySelector('#content,.content,#main,.main') ??
    doc.body;
  if (!main) return '';
  const clone = main.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('script,style,noscript,svg,nav,footer,header,form,input,select,textarea,button,iframe,[aria-hidden=true],[hidden]')
    .forEach((n) => n.remove());
  return truncate(collapseWs(clone.textContent ?? ''), max);
}

export function extractPage(el: Element, opts: { pageChars: number; otherFields: boolean; sendUrl: boolean }): PageContext {
  const doc = el.ownerDocument;
  const form = closestAcrossShadow(el, 'form,[role=form]');
  const formTitle =
    (form && (form.getAttribute('aria-label') || visibleText(form.querySelector('h1,h2,h3,legend'), 120))) ||
    visibleText(doc.querySelector('h1'), 120);

  const otherFields: { label: string; value: string }[] = [];
  if (opts.otherFields) {
    for (const f of siblingFields(el)) {
      if (f === el) continue;
      const ctx = extractField(f);
      if (!ctx || !ctx.currentValue || isSensitive(ctx.semantic)) continue;
      otherFields.push({ label: ctx.label || ctx.name, value: truncate(ctx.currentValue, 300) });
      if (otherFields.length >= 25) break;
    }
  }

  const loc = doc.location;
  return {
    url: opts.sendUrl && loc ? `${loc.origin}${loc.pathname}` : '',
    host: loc?.hostname ?? '',
    title: truncate(collapseWs(doc.title), 200),
    lang: doc.documentElement.lang || navigator.language || 'en',
    formTitle: truncate(formTitle || '', 200),
    pageText: pageMainText(doc, opts.pageChars),
    otherFields,
  };
}
