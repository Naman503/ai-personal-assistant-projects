/**
 * Decides whether a focused element gets FormPilot. If it does, this also
 * decides whether the dropdown opens by itself (password-manager style) or
 * only through the field icon / shortcut.
 */

import type { Settings } from '../settings';
import { fieldKind, editableRoot, resolveLabel, isGenericLabel, conversationQuestion, modalContainer } from './context';
import { classifyField, isSensitive } from './classify';
import { hostMatches } from '../util';

export interface Eligibility {
  ok: boolean;
  /** Chat-questionnaire mode (a listed chat site): re-read the conversation on focus. */
  chat?: boolean;
  reason?: string;
  /** Open the dropdown automatically on focus. */
  autoOpen: boolean;
  /** Show the small sparkle icon inside the field. */
  showIcon: boolean;
}

const NO: Eligibility = { ok: false, autoOpen: false, showIcon: false };

const SEARCH_RE = /(^|\b)(search|query|q|keywords?|find|filter|lookup)(\b|$)/i;

export function siteAllowed(host: string, s: Settings): boolean {
  if (!s.behavior.enabled) return false;
  if (s.behavior.blockedSites.some((p) => hostMatches(host, p))) return false;
  if (s.behavior.siteMode === 'allowlist') return s.behavior.allowedSites.some((p) => hostMatches(host, p));
  return true;
}

export function looksLikeSearch(el: Element): boolean {
  const i = el as HTMLInputElement;
  if (i.type === 'search') return true;
  const role = el.getAttribute('role');
  if (role === 'searchbox' || role === 'combobox') return true;
  if (el.closest('[role=search],form[action*="search" i]')) return true;
  const hints = [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].filter(Boolean).join(' ');
  return SEARCH_RE.test(hints);
}

/** The site already shows its own suggestion list here, so don't pop over it. */
export function hasOwnAutocomplete(el: Element): boolean {
  const ac = el.getAttribute('aria-autocomplete');
  return (
    (ac !== null && ac !== 'none') ||
    el.hasAttribute('list') ||
    el.getAttribute('aria-haspopup') === 'listbox' ||
    el.getAttribute('aria-expanded') !== null
  );
}

export function isChatSite(host: string, s: Settings): boolean {
  return (s.behavior.chatSites ?? []).some((p) => hostMatches(host, p));
}

/** On a chat site: chat-style boxes are generic-labelled fields or rich-text editors. */
export function isChatSiteField(el: Element, host: string, s: Settings): boolean {
  if (!isChatSite(host, s)) return false;
  const ph = el.getAttribute('placeholder') ?? el.getAttribute('data-placeholder') ?? el.getAttribute('aria-placeholder') ?? '';
  return (el as HTMLElement).isContentEditable || isGenericLabel(resolveLabel(el as HTMLElement)) || (!!ph && isGenericLabel(ph)) || el.tagName === 'TEXTAREA';
}

export function isQuestionnaireChat(el: Element): boolean {
  const label = resolveLabel(el as HTMLElement);
  if (!isGenericLabel(label) && !isGenericLabel(el.getAttribute('placeholder') ?? el.getAttribute('data-placeholder') ?? '')) return false;
  return !!modalContainer(el) && conversationQuestion(el).trim().endsWith('?');
}

export function checkEligibility(target: Element, s: Settings, forced = false): Eligibility {
  let el = target;
  const kind0 = fieldKind(el);
  if (kind0 === 'contenteditable') el = editableRoot(el as HTMLElement);
  const kind = kind0;
  if (!kind) return { ...NO, reason: 'not a text field' };

  const h = el as HTMLInputElement;
  if (h.disabled || h.readOnly || el.getAttribute('aria-readonly') === 'true' || el.getAttribute('aria-disabled') === 'true')
    return { ...NO, reason: 'disabled or read-only' };
  if (h.type === 'password' || h.type === 'hidden') return { ...NO, reason: 'password field' };

  const semantic = classifyField({
    inputType: h.type,
    autocomplete: el.getAttribute('autocomplete') ?? '',
    label: resolveLabel(el as HTMLElement),
    name: el.getAttribute('name') ?? '',
    htmlId: el.id,
    placeholder: el.getAttribute('placeholder') ?? '',
  });
  if (isSensitive(semantic)) return { ...NO, reason: `sensitive field (${semantic})` };

  const host = el.ownerDocument.location?.hostname ?? '';
  if (isChatSiteField(el, host, s)) {
    // Listed chat site: always open on focus; none of the generic "should we pop up here" heuristics apply.
    return { ok: true, chat: true, autoOpen: forced || s.behavior.trigger !== 'shortcut', showIcon: s.behavior.trigger !== 'shortcut' && s.behavior.showFieldIcon, reason: 'chat questionnaire site' };
  }
  if (forced) return { ok: true, autoOpen: true, showIcon: false };

  const t = s.behavior.fieldTypes;
  if ((kind === 'input' && !t.input) || (kind === 'textarea' && !t.textarea) || (kind === 'contenteditable' && !t.contenteditable))
    return { ...NO, reason: `${kind} disabled in settings` };
  if (kind === 'select') return { ...NO, reason: 'selects are filled via "Fill form"' };

  const rect = el.getBoundingClientRect();
  if (rect.width && rect.width < s.behavior.minFieldWidth) return { ok: true, autoOpen: false, showIcon: false, reason: 'field too small' };

  if (s.behavior.skipSearchFields && looksLikeSearch(el)) return { ok: true, autoOpen: false, showIcon: false, reason: 'search field' };

  const trigger = s.behavior.trigger;
  let autoOpen = trigger === 'focus';
  if (hasOwnAutocomplete(el)) autoOpen = false;
  if (kind === 'contenteditable' && !s.behavior.autoOpenOnContentEditable) {
    // Exception: a chat-style questionnaire inside a modal/drawer whose last message is a question
    // (job-portal screening bots). Ordinary chat/compose boxes stay icon-only.
    autoOpen = trigger === 'focus' && isQuestionnaireChat(el);
  }
  const showIcon = trigger !== 'shortcut' && s.behavior.showFieldIcon;
  return { ok: true, autoOpen, showIcon };
}
