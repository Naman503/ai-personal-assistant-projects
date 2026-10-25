import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { App, type Actions } from './ui/App';
import { createStore, visibleItems, type Store, type UIState } from './store';
import css from './ui/styles.css?inline';
import { createLogger } from '@/lib/logger';
import type { Settings } from '@/lib/settings';
import { activeProvidersCount } from './providers';
import { SUGGEST_PORT, rpc, track, type FillTrigger, type InsertMethod, type LearnTrigger, type PortEvent, type PortRequest } from '@/lib/messages';
import type { FieldContext, OpenTrigger, Suggestion, SuggestOptions } from '@/lib/types';
import { overlayRoot, conversationQuestion, conversationQuestionInfo, conversationDiagnostics, questionReady, lowestCommonAncestor, describeAncestors } from '@/lib/fields/context';
import { describeConstraints, editableRoot, extractField, extractPage, fieldKind, FID_ATTR, radioGroups, readValue, resolveLabel, siblingFields } from '@/lib/fields/context';
import { checkEligibility, siteAllowed } from '@/lib/fields/eligibility';
import { fillElement, fillRadioGroup, flash, restoreElement } from '@/lib/fields/fill';
import { classifyField, isSensitive } from '@/lib/fields/classify';
import { normalizeText, truncate, uid } from '@/lib/util';
import { clearPosition, loadPositions, positionKey, savePosition, watchPositions, type SavedPos } from '@/lib/panel-position';

interface Engagement {
  el: HTMLElement;
  /** Field snapshot taken at focus/open time (chat questions change after you reply). */
  field: FieldContext;
  /** Normalised texts of every suggestion shown for this field. */
  shown: Set<string>;
  inserted?: string;
  /** The user typed after the last insert. */
  typed: boolean;
  lastTyped: string;
  learned?: string;
}

const log = createLogger('content');

const ADJUST_PROMPTS: Record<string, string> = {
  shorter: 'Make every option noticeably shorter and tighter.',
  longer: 'Make every option more detailed and somewhat longer, still within any max length.',
  formal: 'Use a more formal tone.',
  casual: 'Use a more casual, friendly tone.',
};

/** Is extension context still valid (false after the extension is reloaded/updated)? */
export function contextAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

export class Controller {
  store: Store;
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private root: Root | null = null;
  private port: chrome.runtime.Port | null = null;
  private reqId = '';
  private field: HTMLElement | null = null;
  private genTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private lastOpts: SuggestOptions = {};
  private retriedReq = '';
  /** True while we write into a field, so our own input events don't count as typing. */
  private inserting = false;
  /** What happened on the current field, used to detect user corrections worth remembering. */
  private eng: Engagement | null = null;
  private dead = false;
  /** How the popup was last opened, and whether it has shown suggestions since (anonymous usage only). */
  private openTrigger: OpenTrigger = 'auto';
  private shownReported = false;

  /** Anonymous usage: enums and booleans only, via the background (which applies the off switch). */
  private track(name: string, props?: Record<string, string | number | boolean>) {
    const p = this.settings().privacy;
    if (p.shareUsage && !p.localOnly && !this.dead) track(name, props);
  }

  constructor(private settings: () => Settings) {
    const s = settings();
    this.store = createStore({
      open: false,
      iconVisible: false,
      anchor: null,
      field: null,
      instant: [],
      ai: [],
      status: 'idle',
      active: -1,
      refineOpen: false,
      hasProvider: activeProvidersCount(s) > 0,
      filling: false,
      theme: 'light',
      accent: s.appearance.accent,
      compact: s.appearance.density === 'compact',
      maxWidth: s.appearance.dropdownMaxWidth,
      reduceMotion: s.appearance.reduceMotion,
      ui: s.panel,
      manualPos: null,
      pinned: s.panel.pinnedByDefault,
    });
    this.applyAppearance(s);
    void loadPositions().then((all) => {
      this.positions = all;
      this.syncManualPos();
    });
    this.unwatchPositions = watchPositions((all) => {
      this.positions = all;
      this.syncManualPos();
    });
  }

  // ---------------- Popup position & pinning ----------------

  private positions: Record<string, SavedPos> = {};
  /** Position dragged while "remember" is off: kept until the page reloads. */
  private sessionPos: SavedPos | null = null;
  private unwatchPositions: (() => void) | null = null;
  /** The field the popup was last opened for (click-to-reopen only applies to it). */
  private openedFor: HTMLElement | null = null;

  private posKey(): string | null {
    return positionKey(location.hostname, this.settings().panel.rememberPosition);
  }

  private syncManualPos() {
    const key = this.posKey();
    this.store.set({ manualPos: key ? (this.positions[key] ?? null) : this.sessionPos });
  }

  /** Called by the UI when a drag ends. */
  savePanelPosition(pos: SavedPos) {
    const key = this.posKey();
    this.store.set({ manualPos: pos });
    if (!key) {
      this.sessionPos = pos;
      return;
    }
    this.positions[key] = pos;
    void savePosition(key, pos).catch((e) => log.warn('could not save popup position', e));
    log.info(`popup moved (${pos.mode === 'screen' ? 'fixed on screen' : 'follows the field'}${key === '*' ? ', everywhere' : `, on ${key}`})`);
  }

  resetPanelPosition() {
    const key = this.posKey();
    this.sessionPos = null;
    if (key) {
      delete this.positions[key];
      void clearPosition(key);
    }
    this.store.set({ manualPos: null });
    this.showToast('Popup position reset', 'info', undefined, 2000);
  }

  togglePin() {
    const pinned = !this.store.get().pinned;
    this.store.set({ pinned });
    if (!pinned && this.field && document.activeElement !== this.field && !this.field.contains(document.activeElement)) {
      // Unpinned while focus is elsewhere: behave as if the field just lost focus.
      this.onBlur(document.activeElement);
    }
  }

  // ---------------- UI mounting ----------------

  /**
   * Mount lazily on first use.
   *
   * Overlays (modals, drawers, chat widgets) break naive in-page UIs in three ways, and each is handled here:
   *  1. Stacking: the page's overlay has a huge z-index or its own stacking context, so it covers us.
   *     → The host is a `popover="manual"` element shown in the browser's top layer, above every z-index.
   *  2. Inertness / focus traps: content outside a modal is inert (`<dialog>`), or a focus-trap library
   *     yanks focus back into the modal and treats our clicks as "outside" and closes the modal.
   *     → When the field is inside a dialog / [aria-modal] container, the host is mounted *inside* it.
   *       The top layer still positions it against the viewport, so transforms on the container don't matter.
   *  3. Click-outside handlers on the document. → Pointer/mouse/key events never bubble out of our shadow root.
   */
  private ensureUI(near?: Element | null) {
    const modal = near ? this.mountPointFor(near) : null;
    const parent: Element = modal ?? document.documentElement;
    if (this.host && this.host.parentElement === parent && this.host.isConnected) {
      this.bringToFront();
      return;
    }
    if (!this.host) {
      this.host = document.createElement('formpilot-ui');
      this.host.setAttribute(
        'style',
        [
          'all: initial',
          'display: block',
          'position: fixed',
          'inset: auto',
          'top: 0',
          'left: 0',
          'width: 0',
          'height: 0',
          'margin: 0',
          'padding: 0',
          'border: 0',
          'overflow: visible',
          'background: transparent',
          'z-index: 2147483647',
          'pointer-events: auto',
          'transform: none',
          'opacity: 1',
          'visibility: visible',
        ]
          .map((d) => `${d} !important`)
          .join('; '),
      );
      this.host.setAttribute('popover', 'manual');
      // Closed shadow root: page scripts and styles can't reach our UI or the suggestions in it.
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = css;
      const mount = document.createElement('div');
      this.shadow.append(style, mount);
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'wheel', 'focusin', 'focusout']) {
        this.shadow.addEventListener(type, (e) => e.stopPropagation());
      }
      this.root = createRoot(mount);
      // Mirror coarse UI state on the host (no content), handy for debugging and e2e tests.
      this.store.subscribe(() => {
        const st = this.store.get();
        this.host?.setAttribute('data-open', String(st.open));
        this.host?.setAttribute('data-status', st.status);
        this.host?.setAttribute('data-items', String(visibleItems(st).length));
        this.host?.setAttribute('data-toast', st.toast ? st.toast.tone : '');
      });
      this.root.render(createElement(App, { store: this.store, actions: this.actions }));
      log.debug('UI mounted');
    }
    parent.appendChild(this.host);
    if (modal) log.info(`field is inside a popup/drawer <${modal.tagName.toLowerCase()}${modal.id ? '#' + modal.id : ''}>: mounting the dropdown inside it (top layer)`);
    this.bringToFront();
  }

  /**
   * Chat mode: mount in the lowest element containing both the input and the question bubble.
   * That element is necessarily inside the site's popup, so its click-outside logic sees our clicks as inside.
   */
  private mountPointFor(near: Element): Element | null {
    if (this.chatMode) {
      const { block } = conversationQuestionInfo(near);
      const lca = block ? lowestCommonAncestor(near, block) : null;
      if (lca) return lca;
    }
    return closestModal(near);
  }

  /** (Re-)enter the top layer so we are above any overlay opened after us. */
  private bringToFront() {
    const h = this.host as (HTMLElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!h?.showPopover) return;
    try {
      if (h.matches(':popover-open')) h.hidePopover!();
      h.showPopover();
    } catch (e) {
      log.debug('popover top layer unavailable, falling back to z-index', e);
    }
  }

  isOurs(node: EventTarget | null): boolean {
    return !!node && (node === this.host || (node instanceof Node && !!this.host?.contains(node)));
  }

  applyAppearance(s: Settings) {
    const dark =
      s.appearance.theme === 'dark' || (s.appearance.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    this.store?.set({
      theme: dark ? 'dark' : 'light',
      accent: s.appearance.accent,
      compact: s.appearance.density === 'compact',
      maxWidth: s.appearance.dropdownMaxWidth,
      reduceMotion: s.appearance.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches,
      hasProvider: activeProvidersCount(s) > 0,
      ui: s.panel,
    });
    if (this.positions) this.syncManualPos();
  }

  // ---------------- Port ----------------

  private getPort(): chrome.runtime.Port | null {
    if (this.port) return this.port;
    if (!contextAlive()) {
      this.handleDeadContext();
      return null;
    }
    try {
      const p = chrome.runtime.connect({ name: SUGGEST_PORT });
      p.onMessage.addListener((e: PortEvent) => this.onPortEvent(e));
      p.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        log.debug('port disconnected (service worker restarted?)');
        this.port = null;
        if (['retrieving', 'generating', 'streaming'].includes(this.store.get().status) && this.retriedReq !== this.reqId) {
          // Retry once on a fresh port. The service worker may have been recycled mid-request.
          log.info('re-sending request on a new port');
          this.request({ ...this.lastOpts, kind: 'retry' }, true);
        }
      });
      this.port = p;
      return p;
    } catch (e) {
      log.warn('could not connect to background', e);
      this.handleDeadContext();
      return null;
    }
  }

  private handleDeadContext() {
    if (this.dead) return;
    this.dead = true;
    log.warn('FormPilot was reloaded or updated. Refresh this page to keep using it.');
    this.store.set({ status: 'error', error: { code: 'unavailable', message: 'FormPilot was updated.', hint: 'Refresh this page to reconnect.' } });
  }

  private onPortEvent(e: PortEvent) {
    if (e.reqId !== this.reqId) return; // stale response for a previous field
    if (this.eng && (e.type === 'instant' || e.type === 'done')) for (const it of e.items) this.eng.shown.add(normalizeText(it.text));
    const st = this.store.get();
    switch (e.type) {
      case 'instant':
        this.store.set({ instant: e.items, status: st.status === 'idle' ? 'instant' : st.status, active: e.items.length && st.active < 0 ? 0 : st.active });
        log.debug(`instant ${e.items.length}`);
        break;
      case 'status':
        this.store.set({ status: e.stage, providerLabel: e.provider ?? st.providerLabel });
        break;
      case 'partial':
        this.store.set({ ai: e.items, status: 'streaming', active: st.active < 0 ? 0 : st.active });
        break;
      case 'done':
        this.store.set({ ai: e.items, status: 'done', meta: e.meta, active: st.active < 0 && (e.items.length || st.instant.length) ? 0 : st.active });
        log.info(`suggestions ready: ${e.items.length} AI + ${st.instant.length} instant`, e.meta);
        break;
      case 'error':
        this.store.set({ status: 'error', error: e.error });
        log.warn(`suggestion error [${e.error.code}] ${e.error.message}`, e.error.hint);
        break;
    }
    // Once per open: the first time it has something to pick from (denominator of the acceptance rate).
    if (!this.shownReported && this.store.get().open && visibleItems(this.store.get()).length) {
      this.shownReported = true;
      this.track('suggestions_shown', {
        first: e.type === 'instant' ? 'instant' : e.type === 'done' && e.meta.cached ? 'cache' : 'ai',
        trigger: this.openTrigger,
      });
    }
  }

  // ---------------- Field lifecycle ----------------

  onFocus(target: HTMLElement) {
    if (this.dead || this.inserting || this.store.get().filling) return;
    const s = this.settings();
    const el = fieldKind(target) === 'contenteditable' ? editableRoot(target) : target;
    if (el === this.field) {
      clearTimeout(this.closeTimer);
      return;
    }
    if (!siteAllowed(location.hostname, s)) return;
    const elig = checkEligibility(el, s);
    const desc = `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.isContentEditable ? ' contenteditable' : ''}>`;
    if (!elig.ok) {
      if (!loggedSkips.has(el)) log.info(`not offering suggestions on ${desc}: ${elig.reason}`);
      loggedSkips.add(el);
      return;
    }
    log.info(`focus ${desc} → ${elig.autoOpen ? 'auto-open' : elig.showIcon ? 'icon only' : 'shortcut only'}${elig.reason ? ` (${elig.reason})` : ''}`);
    this.track('field_focused', { mode: elig.autoOpen ? 'auto_open' : elig.showIcon ? 'icon' : 'shortcut', chat: !!elig.chat });
    this.attach(el, !!elig.chat);
    this.store.set({ iconVisible: elig.showIcon });
    if (elig.chat) {
      const info = conversationQuestionInfo(el);
      const mount = this.mountPointFor(el);
      // One line with everything needed to debug a site we can't see.
      log.info('chat field diagnostics', {
        question: info.text,
        via: info.via,
        strategies: conversationDiagnostics(el),
        questionBlock: info.block ? describeAncestors(info.block, 3) : null,
        mountInside: mount ? describeAncestors(mount, 3) : 'document (no container found)',
        field: describeAncestors(el, 10),
      });
      if (elig.autoOpen) this.openWhenQuestionReady(el);
    } else if (elig.autoOpen) this.open({ auto: true, trigger: 'auto' });
  }

  onBlur(next: EventTarget | null) {
    if (this.isOurs(next) || this.inserting || this.store.get().filling) return;
    clearTimeout(this.closeTimer);
    // Small delay: clicks on the panel move focus before the click event fires.
    this.closeTimer = setTimeout(() => {
      const a = document.activeElement;
      if (this.isOurs(a) || (this.field && (a === this.field || this.field.contains(a)))) return;
      const st = this.store.get();
      if (st.open && (st.pinned || !this.settings().panel.closeOnBlur)) {
        // Keep the popup on screen (still bound to this field); just hide the field icon.
        this.maybeLearn('blur');
        this.store.set({ iconVisible: false });
        return;
      }
      this.detach();
    }, 160);
  }

  /** User typed in the field: hide the panel (their own text wins), keep the icon. */
  onUserInput(target?: EventTarget | null) {
    if (this.inserting) return;
    const e = this.eng;
    if (e && target instanceof Node && (target === e.el || e.el.contains(target))) {
      e.typed = true;
      e.lastTyped = readValue(e.el);
    }
    const st = this.store.get();
    if (st.open && !st.refineOpen && !st.pinned && this.settings().panel.hideWhileTyping) this.close();
  }

  /** A click on a field: bring the popup back if it was closed (Esc / insert) while the field kept focus. */
  onFieldClick(target: HTMLElement) {
    if (this.dead || !this.settings().panel.reopenOnClick) return;
    const el = fieldKind(target) === 'contenteditable' ? editableRoot(target) : target;
    if (el !== this.field || this.store.get().open) return;
    // Only bring back a popup that was open for this field, or one that would open on its own.
    // (Search boxes, icon-only and shortcut-only fields stay quiet.)
    const elig = checkEligibility(el, this.settings());
    if (!elig.ok || (this.openedFor !== el && !elig.autoOpen)) return;
    log.debug('field clicked: reopening the popup');
    if (this.chatMode) this.openWhenQuestionReady(el, undefined, 'click_reopen');
    else this.open({ auto: true, trigger: 'click_reopen' });
  }

  /** A form is being submitted: learn from the field before the page navigates away. */
  onSubmit() {
    this.maybeLearn('submit');
  }

  // ---------------- Learning from corrections ----------------

  /**
   * If you typed your own answer (or edited a suggestion) where FormPilot made suggestions,
   * offer to remember it, or remember it silently in "auto" mode.
   */
  private maybeLearn(reason: string) {
    const e = this.eng;
    if (!e || !e.typed || this.dead) return;
    const s = this.settings();
    if (s.cache.learn === 'off') return;
    const value = (readValue(e.el).trim() || e.lastTyped.trim()).slice(0, 20000);
    if (!value || isSensitive(e.field.semantic) || (e.el as HTMLInputElement).type === 'password') return;
    const n = normalizeText(value);
    if (!n || e.learned === n) return;
    // Only where FormPilot actually suggested something: that is where a correction means something.
    if (!e.shown.size && e.inserted === undefined) return;
    // Typed exactly one of the suggestions: not a correction.
    if (e.shown.has(n)) return;
    e.learned = n;
    const field: FieldContext = { ...e.field, currentValue: '' };
    const q = field.label || field.placeholder || field.name || 'this field';
    log.info(`correction detected (${reason}) for "${q}"`);
    const save = (trigger: LearnTrigger) =>
      rpc<{ savedAs: string[] }>({ type: 'learn', field, text: value, host: location.hostname, trigger })
        .then((r) => this.showToast(`Saved to memory${r.savedAs.includes('fact') ? ' as a key fact' : r.savedAs.includes('note') ? ' (Saved answers)' : ''}. FormPilot will use it next time.`, 'success', undefined, 3500))
        .catch((err) => this.showToast(`Couldn't save: ${(err as Error).message}`, 'error'));
    if (s.cache.learn === 'auto') return void save('auto');
    this.track('learn_prompt', { action: 'shown' });
    this.showToast(
      `Remember “${truncate(value, 40)}” as your answer to “${truncate(q, 60)}”?`,
      'info',
      [
        { label: 'Remember', primary: true, run: () => (this.track('learn_prompt', { action: 'accepted' }), void save('ask')) },
        { label: 'Not now', run: () => this.track('learn_prompt', { action: 'dismissed' }) },
      ],
      12_000,
    );
  }

  /** Save what's in the focused field right now (dropdown button, right-click menu). */
  rememberActive(trigger: LearnTrigger = 'button') {
    let el = this.field ?? deepActiveElement();
    if (el && fieldKind(el) === 'contenteditable') el = editableRoot(el);
    if (!el || !fieldKind(el)) return this.showToast('Click into the field with your answer first.', 'info');
    const value = readValue(el).trim();
    if (!value) return this.showToast('Type your answer in the field first, then save it.', 'info');
    const field = (this.eng?.el === el ? this.eng.field : extractField(el)) ?? null;
    if (!field || isSensitive(field.semantic)) return this.showToast("FormPilot doesn't store sensitive fields.", 'info');
    if (this.eng?.el === el) this.eng.learned = normalizeText(value);
    void rpc<{ savedAs: string[] }>({ type: 'learn', field: { ...field, currentValue: '' }, text: value, host: location.hostname, trigger })
      .then(() => this.showToast(`Saved “${truncate(value, 40)}” for “${truncate(field.label || field.name, 50)}”.`, 'success', undefined, 3500))
      .catch((err) => this.showToast(`Couldn't save: ${(err as Error).message}`, 'error'));
    this.close();
  }

  private convoObserver: MutationObserver | null = null;
  private lastQuestion = '';
  /** Current field is a chat-questionnaire box on a listed chat site. */
  private chatMode = false;
  private questionTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Chat site: the popup focuses the input, and the bot's question may render a moment later.
   * Re-read the page every 250 ms for up to 4 s and open as soon as a question is there (or after the wait anyway).
   */
  private openWhenQuestionReady(el: HTMLElement, previous?: string, trigger: OpenTrigger = 'chat_question') {
    clearTimeout(this.questionTimer);
    const t0 = Date.now();
    const tick = () => {
      if (this.field !== el || !el.isConnected) return;
      const info = conversationQuestionInfo(el);
      const q = info.text;
      // After a reply, the old question stays the last bubble until the bot asks the next one.
      const ready = questionReady(info) && q !== previous;
      // Naukri loads questions from its API, so allow a generous wait for the first one.
      if (ready || Date.now() - t0 > 8000) {
        this.lastQuestion = q;
        this.track('chat_question', { found: ready });
        log.info(
          ready
            ? `chat question found via ${info.via} after ${Date.now() - t0}ms: "${truncate(q, 90)}"`
            : `no question found within 8s, opening anyway`,
          ready ? undefined : conversationDiagnostics(el),
        );
        this.startEngagement(el);
        this.open({ auto: true, trigger });
      } else this.questionTimer = setTimeout(tick, 250);
    };
    tick();
  }

  /**
   * Chat widgets often focus the input *before* the bot's question renders, then ask the next
   * question after each reply. Watch the popup while the field is focused: when a new question
   * appears, (re)open suggestions for it.
   */
  private watchConversation(el: HTMLElement) {
    this.convoObserver?.disconnect();
    this.convoObserver = null;
    // Chat sites: observe the whole page (the popup may not be detectable); elsewhere only the popup.
    const root = this.chatMode ? el.ownerDocument.body : overlayRoot(el);
    if (!root) return;
    this.lastQuestion = conversationQuestion(el);
    let t: ReturnType<typeof setTimeout> | undefined;
    this.convoObserver = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (this.field !== el || !el.isConnected) return;
        const active = deepActiveElement();
        if (active !== el && !el.contains(active)) return;
        const q = conversationQuestion(el);
        if (!q || q === this.lastQuestion) return;
        this.lastQuestion = q;
        if (readValue(el).trim()) return; // user is mid-answer
        const elig = checkEligibility(el, this.settings());
        log.info(`new question in the popup: "${truncate(q, 80)}" → ${elig.autoOpen ? 'opening suggestions' : 'icon only'}`);
        this.startEngagement(el);
        if (elig.autoOpen) this.open({ auto: true, trigger: 'chat_question' });
      }, 350);
    });
    this.convoObserver.observe(root, { childList: true, subtree: true, characterData: true });
  }

  private startEngagement(el: HTMLElement) {
    const f = extractField(el, { chat: this.chatMode });
    this.eng = f ? { el, field: f, shown: new Set(), typed: false, lastTyped: '' } : null;
  }

  private attach(el: HTMLElement, chat = false) {
    this.detach();
    this.field = el;
    this.openedFor = null;
    this.chatMode = chat;
    this.startEngagement(el);
    this.watchConversation(el);
    this.ensureUI(el);
    this.store.set({ anchor: el, field: null, instant: [], ai: [], status: 'idle', error: undefined, meta: undefined, active: -1, refineOpen: false });
  }

  detach() {
    this.maybeLearn('blur');
    this.eng = null;
    this.convoObserver?.disconnect();
    this.convoObserver = null;
    clearTimeout(this.questionTimer);
    this.cancel();
    clearTimeout(this.closeTimer);
    this.field = null;
    this.store.set({ open: false, iconVisible: false, anchor: null, field: null, refineOpen: false });
  }

  close() {
    this.cancel();
    this.store.set({ open: false, refineOpen: false });
  }

  private cancel() {
    clearTimeout(this.genTimer);
    if (this.reqId && this.port) {
      try {
        this.port.postMessage({ type: 'cancel', reqId: this.reqId } satisfies PortRequest);
      } catch {
        /* port gone */
      }
    }
    this.reqId = '';
  }

  /** Open the panel for the current field. */
  open({ auto = false, forced = false, trigger }: { auto?: boolean; forced?: boolean; trigger?: OpenTrigger } = {}) {
    const el = this.field;
    if (!el) return;
    if (forced) {
      const elig = checkEligibility(el, this.settings(), true);
      if (!elig.ok) {
        this.showToast(`FormPilot doesn't fill this field (${elig.reason}).`, 'info');
        return;
      }
    }
    const field = extractField(el, { chat: this.chatMode });
    if (!field) return;
    this.ensureUI(el);
    this.store.set({ open: true, field, instant: [], ai: [], status: 'idle', error: undefined, meta: undefined, active: -1 });
    if (this.eng?.el === el) this.eng.field = field;
    else this.startEngagement(el);
    this.openedFor = el;
    this.openTrigger = trigger ?? (auto ? 'auto' : 'icon');
    this.shownReported = false;
    log.info(`open "${field.label}" [${field.kind}/${field.semantic}${field.maxLength ? `/max ${field.maxLength}` : ''}]`);
    const s = this.settings();
    // Instant results right away; AI after a short debounce (cancelled if focus moves).
    this.request({ instantOnly: true, trigger: this.openTrigger });
    if ((s.behavior.autoGenerate || !auto) && this.store.get().hasProvider) {
      clearTimeout(this.genTimer);
      this.genTimer = setTimeout(() => this.request({ kind: 'initial' }), auto ? s.behavior.generateDelayMs : 0);
    }
  }

  private request(opts: SuggestOptions, isRetry = false) {
    const el = this.field;
    const st = this.store.get();
    if (!el || !st.field) return;
    const port = this.getPort();
    if (!port) return;
    const s = this.settings();
    this.lastOpts = opts;
    this.reqId = uid('r');
    if (isRetry) this.retriedReq = this.reqId;
    // Refresh the field's current value (user may have typed).
    const field: FieldContext = { ...st.field, currentValue: extractField(el)?.currentValue ?? st.field.currentValue };
    const page = extractPage(el, {
      pageChars: s.generation.includePageContext ? s.generation.pageContextChars : 0,
      otherFields: s.generation.includeOtherFields,
      sendUrl: s.privacy.sendPageUrl,
    });
    if (!opts.instantOnly) this.store.set({ status: 'generating', error: undefined, ai: opts.refine || opts.fresh ? [] : st.ai });
    try {
      port.postMessage({ type: 'suggest', reqId: this.reqId, field, page, opts, constraints: describeConstraints(el) } satisfies PortRequest);
    } catch (e) {
      log.warn('postMessage failed, reconnecting', e);
      this.port = null;
      const p2 = this.getPort();
      p2?.postMessage({ type: 'suggest', reqId: this.reqId, field, page, opts, constraints: describeConstraints(el) } satisfies PortRequest);
    }
  }

  // ---------------- Keyboard ----------------

  /** Returns true if the key was handled (and should be swallowed). */
  onKeyDown(e: KeyboardEvent): boolean {
    const st = this.store.get();
    if (!this.field) return false;
    if (!st.open) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (this.eng?.field.chat || this.chatMode) && this.eng?.typed) {
        // Chat questionnaire: Enter sends the reply and the site clears the box. Learn now, before it is cleared,
        // then load suggestions for the next question once the bot has asked it.
        this.maybeLearn('chat-send');
        const el = this.field;
        setTimeout(() => {
          if (!el || this.field !== el || !el.isConnected) return;
          if (readValue(el).trim()) return;
          if (this.chatMode) return this.openWhenQuestionReady(el, this.lastQuestion);
          this.startEngagement(el);
          if (checkEligibility(el, this.settings()).autoOpen) this.open({ auto: true, trigger: 'chat_question' });
        }, 600);
        return false;
      }
      if (e.key === 'ArrowDown' && e.altKey) {
        this.track('popup_key', { key: 'alt_down' });
        this.open({ forced: true, trigger: 'alt_down' });
        return true;
      }
      return false;
    }
    const items = visibleItems(st);
    switch (e.key) {
      case 'Escape':
        this.track('popup_key', { key: 'escape' });
        this.close();
        return true;
      case 'ArrowDown':
        if (!items.length) return false;
        this.track('popup_key', { key: 'arrows' });
        this.store.set({ active: (st.active + 1) % items.length });
        return true;
      case 'ArrowUp':
        if (!items.length) return false;
        this.track('popup_key', { key: 'arrows' });
        this.store.set({ active: st.active <= 0 ? items.length - 1 : st.active - 1 });
        return true;
      case 'Enter': {
        if (e.shiftKey || e.isComposing) return false;
        const it = items[st.active];
        if (it) {
          this.track('popup_key', { key: 'enter' });
          this.insert(it, 'enter');
          return true;
        }
        if (!items.length && st.status === 'idle' && st.hasProvider) {
          this.track('popup_key', { key: 'enter' });
          this.request({ kind: 'manual' });
          return true;
        }
        return false;
      }
      case 'Tab': {
        const it = items[st.active];
        if (this.settings().panel.tabAccepts && it && !e.shiftKey) {
          this.track('popup_key', { key: 'tab' });
          this.insert(it, 'tab');
          return true;
        }
        if (!st.pinned) this.close();
        return false;
      }
    }
    // Alt+1…9 inserts that suggestion (e.code, because Alt+digit types symbols on macOS).
    const digit = e.altKey && !e.ctrlKey && !e.metaKey ? /^Digit([1-9])$/.exec(e.code) : null;
    if (digit && this.settings().panel.numberShortcuts) {
      const it = items[Number(digit[1]) - 1];
      if (it) {
        this.track('popup_key', { key: 'alt_number' });
        this.insert(it, 'alt_number');
        return true;
      }
    }
    return false;
  }

  // ---------------- Insertion ----------------

  private resolveField(): HTMLElement | null {
    if (this.field?.isConnected) return this.field;
    // Re-rendered by the page? Find it again by our id, then by name/id.
    const fid = this.store.get().field?.fid;
    const st = this.store.get().field;
    const again =
      (fid && document.querySelector<HTMLElement>(`[${FID_ATTR}="${fid}"]`)) ||
      (st?.htmlId && document.getElementById(st.htmlId)) ||
      (st?.name && document.querySelector<HTMLElement>(`[name="${CSS.escape(st.name)}"]`));
    return (again as HTMLElement) || null;
  }

  insert(s: Suggestion, method: InsertMethod = 'click') {
    const el = this.resolveField();
    const field = this.store.get().field;
    if (!el || !field) {
      this.showToast('The field is gone. The page re-rendered it.', 'error');
      return;
    }
    const cfg = this.settings();
    this.inserting = true;
    let res;
    try {
      res = fillElement(el, s.text, cfg.behavior.insertMode);
    } finally {
      this.inserting = false;
    }
    if (!res.ok) {
      log.warn(`insert failed via ${res.method}`, { field: field.label });
      this.track('insert_failed', { source: s.source === 'fact' ? 'memory' : s.source });
      void navigator.clipboard?.writeText(s.text).catch(() => {});
      this.showToast("Couldn't insert here, so the text was copied. Press Ctrl/⌘+V.", 'error');
      return;
    }
    if (this.eng?.el === el || this.eng?.el === this.field) {
      this.eng!.inserted = s.text;
      this.eng!.typed = false;
      this.eng!.shown.add(normalizeText(s.text));
    }
    if (cfg.behavior.highlightOnFill) flash(el, getAccent(this.store.get().accent));
    log.info(`inserted ${s.source} suggestion via ${res.method} (${s.text.length} chars)`);
    const rank = visibleItems(this.store.get()).findIndex((x) => x.id === s.id) + 1;
    void rpc({ type: 'accept', field, text: s.text, host: location.hostname, source: s.source, method, rank }).catch((e) => log.debug('accept rpc failed', e));
    if (cfg.behavior.closeOnInsert) this.close();
    if (res.method !== 'execCommand') {
      this.showToast('Inserted', 'success', { label: 'Undo', run: () => (this.track('undo_used', { what: 'insert' }), restoreElement(el, res.previous)) });
    }
  }

  // ---------------- Whole-form fill ----------------

  async fillForm(trigger: FillTrigger = 'popup_menu') {
    const anchor = this.field ?? (document.activeElement as HTMLElement | null);
    if (!anchor || this.store.get().filling) return;
    if (!contextAlive()) return this.handleDeadContext();
    this.ensureUI(anchor);
    const s = this.settings();
    const els = siblingFields(anchor === document.body ? document.body : anchor);

    // Group radios by name into one pseudo-select; skip sensitive / disabled / filled.
    const entries: { id: string; field: FieldContext; el: HTMLElement; radios?: HTMLInputElement[] }[] = [];
    for (const el of els) {
      const h = el as HTMLInputElement;
      if (h.disabled || h.readOnly) continue;
      const f = extractField(el);
      if (!f || isSensitive(f.semantic) || h.type === 'password') continue;
      if (f.currentValue.trim() && f.kind !== 'select') continue; // never overwrite user input
      if (f.kind === 'select' && (el as HTMLSelectElement).selectedIndex > 0) continue;
      entries.push({ id: `f${entries.length + 1}`, field: f, el });
    }
    // checkboxes are skipped: consent boxes must be ticked by the user.
    for (const [, radios] of radioGroups(anchor === document.body ? document.body : anchor)) {
      if (radios.some((r) => r.checked)) continue;
      const first = radios[0];
      const groupLabel = first.closest('fieldset')?.querySelector('legend')?.textContent?.trim() || resolveLabel(first.parentElement as HTMLElement) || first.name;
      const options = radios.map((r) => ({ value: r.value, label: resolveLabel(r) || r.value }));
      const semantic = classifyField({ label: groupLabel, name: first.name });
      if (isSensitive(semantic)) continue;
      entries.push({
        id: `f${entries.length + 1}`,
        el: first,
        radios,
        field: {
          fid: first.getAttribute(FID_ATTR) ?? uid('f'),
          kind: 'select',
          inputType: 'radio',
          label: groupLabel,
          name: first.name,
          htmlId: first.id,
          placeholder: '',
          autocomplete: '',
          description: '',
          section: '',
          required: first.required,
          options,
          currentValue: '',
          semantic,
          longForm: false,
        },
      });
    }
    const fillable = entries.filter((e) => (e.field.kind !== 'select' || e.field.options?.length) && e.el.getAttribute('type') !== 'checkbox');
    if (!fillable.length) {
      this.showToast('No empty fields to fill in this form.', 'info');
      return;
    }
    log.info(`fill-form: ${fillable.length} empty fields`);
    this.store.set({ filling: true, open: false });
    this.showToast(`Filling ${fillable.length} fields…`, 'info', undefined, 60_000);
    try {
      const page = extractPage(anchor, { pageChars: s.generation.includePageContext ? s.generation.pageContextChars : 0, otherFields: true, sendUrl: s.privacy.sendPageUrl });
      const res = await rpc<{ values: Record<string, string>; sources: Record<string, string>; ms: number }>({
        type: 'fill-form',
        fields: fillable.map(({ id, field }) => ({ id, field })),
        page,
        trigger,
      });
      const undo: { el: HTMLElement; previous: string; radios?: HTMLInputElement[] }[] = [];
      let n = 0;
      for (const e of fillable) {
        const v = res.values[e.id];
        if (!v?.trim()) continue;
        this.inserting = true;
        const r = e.radios
          ? fillRadioGroup(e.radios, v, (x) => resolveLabel(x) || x.value)
          : fillElement(e.el, v, 'replace');
        this.inserting = false;
        if (r.ok) {
          n++;
          undo.push({ el: e.el, previous: r.previous, radios: e.radios });
          if (s.behavior.highlightOnFill) flash(e.radios ? (e.radios[0].parentElement ?? e.el) : e.el, getAccent(this.store.get().accent));
          // Fire blur so frameworks run validation / mark as touched.
          e.el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        } else log.debug(`fill-form could not set "${e.field.label}" to "${v.slice(0, 40)}"`);
      }
      anchor.focus?.({ preventScroll: true });
      log.info(`fill-form: filled ${n}/${fillable.length} in ${res.ms}ms`);
      this.track('form_fill_applied', { fields: fillable.length, filled: n, trigger });
      this.showToast(
        n ? `Filled ${n} of ${fillable.length} fields · check before submitting` : 'Nothing to fill from your memory.',
        n ? 'success' : 'info',
        n
          ? {
              label: 'Undo',
              run: () => {
                this.track('undo_used', { what: 'form' });
                for (const u of undo.reverse()) {
                  if (u.radios) u.radios.forEach((r) => (r.checked = r.value === u.previous));
                  else restoreElement(u.el, u.previous);
                }
                this.showToast('Restored', 'info');
              },
            }
          : undefined,
        12_000,
      );
    } catch (e) {
      const msg = (e as Error).message;
      log.error('fill-form failed', e);
      this.showToast(`Fill failed: ${msg}`, 'error', { label: 'Settings', run: () => this.actions.openSettings('providers') }, 8000);
    } finally {
      this.store.set({ filling: false });
    }
  }

  // ---------------- Toast ----------------

  showToast(
    text: string,
    tone: 'info' | 'success' | 'error',
    action?: { label: string; run: () => void; primary?: boolean } | { label: string; run: () => void; primary?: boolean }[],
    ms = 5000,
  ) {
    this.ensureUI(this.field);
    clearTimeout(this.toastTimer);
    const id = Date.now();
    const list = action ? (Array.isArray(action) ? action : [action]) : [];
    const actions = list.map((a) => ({ ...a, run: () => (this.store.set({ toast: undefined }), a.run()) }));
    this.store.set({ toast: { id, text, tone, actions } });
    this.toastTimer = setTimeout(() => {
      if (this.store.get().toast?.id === id) this.store.set({ toast: undefined });
    }, ms);
  }

  // ---------------- Actions exposed to the UI ----------------

  actions: Actions = {
    insert: (s) => this.insert(s, 'click'),
    generate: () => (this.track('popup_action', { action: 'generate' }), this.request({ kind: 'manual' })),
    regenerate: () => (this.track('popup_action', { action: 'regenerate' }), this.request({ fresh: true, kind: 'regenerate' })),
    adjust: (k) => {
      if (k === 'shorter' || k === 'longer') this.track('popup_action', { action: k });
      this.request({ refine: ADJUST_PROMPTS[k], fresh: true, kind: k });
    },
    refine: (text) => {
      this.track('popup_action', { action: 'refine' });
      this.store.set({ refineOpen: false });
      this.field?.focus({ preventScroll: true });
      this.request({ refine: text, fresh: true, kind: 'refine' });
    },
    toggleRefine: (open) => {
      const next = open ?? !this.store.get().refineOpen;
      if (next) this.track('popup_action', { action: 'refine_open' });
      this.store.set({ refineOpen: next });
      if (!next) this.field?.focus({ preventScroll: true });
    },
    close: () => (this.track('popup_action', { action: 'close' }), this.close()),
    openFromIcon: () => (this.store.get().open ? this.close() : this.open({ forced: true, trigger: 'icon' })),
    openSettings: (section) => {
      if (!contextAlive()) return this.handleDeadContext();
      this.track('popup_action', { action: 'settings' });
      void rpc({ type: 'open-options', section }).catch(() => {});
      this.close();
    },
    fillForm: () => (this.track('popup_action', { action: 'fill_form' }), void this.fillForm('popup_menu')),
    pauseSite: () => {
      this.track('popup_action', { action: 'pause_site' });
      this.eng = null;
      void rpc({ type: 'site-toggle', host: location.hostname, enabled: false });
      this.detach();
      this.showToast(`FormPilot paused on ${location.hostname}. Re-enable it from the toolbar icon.`, 'info');
    },
    setActive: (i) => this.store.set({ active: i }),
    remember: () => (this.track('popup_action', { action: 'remember' }), this.rememberActive('button')),
    savePosition: (pos) => (this.track('popup_action', { action: 'move' }), this.savePanelPosition(pos)),
    resetPosition: () => (this.track('popup_action', { action: 'reset_position' }), this.resetPanelPosition()),
    togglePin: () => (this.track('popup_action', { action: this.store.get().pinned ? 'unpin' : 'pin' }), this.togglePin()),
  };

  /** Called for the keyboard command / context menu. */
  openForActiveElement(trigger: OpenTrigger = 'shortcut') {
    let a = deepActiveElement();
    if (!a || a === document.body) {
      this.showToast('Click into a form field first.', 'info');
      return;
    }
    if (fieldKind(a) === 'contenteditable') a = editableRoot(a);
    if (a !== this.field) this.attach(a, !!checkEligibility(a, this.settings(), true).chat);
    this.open({ forced: true, trigger });
  }

  setFieldState(patch: Partial<UIState>) {
    this.store.set(patch);
  }

  destroy() {
    this.unwatchPositions?.();
    this.cancel();
    this.port?.disconnect();
    this.root?.unmount();
    this.host?.remove();
  }
}

const loggedSkips = new WeakSet<Element>();

/** Where to mount the UI so clicks on it count as "inside" the page's popup. */
function closestModal(el: Element): Element | null {
  return overlayRoot(el);
}

export function deepActiveElement(): HTMLElement | null {
  let a: Element | null = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a as HTMLElement | null;
}

function getAccent(name: string): string {
  return ({ violet: '#7c3aed', blue: '#2563eb', emerald: '#059669', orange: '#ea580c', rose: '#e11d48', slate: '#475569' } as Record<string, string>)[name] ?? '#7c3aed';
}
