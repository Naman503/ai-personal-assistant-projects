import { addLogSink, configureLogger, createLogger } from '@/lib/logger';
import { DEFAULTS, loadSettingsLite, watchSettingsLite } from '@/lib/settings-core';
import type { Settings } from '@/lib/settings';
import { fieldKind } from '@/lib/fields/context';
import { Controller, contextAlive } from './controller';
import type { TabCommand } from '@/lib/messages';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  // Also run in about:srcdoc / blob: frames (chat widgets are often built that way).
  matchOriginAsFallback: true,
  runAt: 'document_idle',
  cssInjectionMode: 'manual',

  async main(ctx) {
    configureLogger({ context: 'content' });
    const log = createLogger('content');

    let settings: Settings = DEFAULTS;
    try {
      settings = await loadSettingsLite();
    } catch (e) {
      log.warn('could not load settings, using defaults', e);
    }
    configureLogger({ level: settings.debug.logLevel, console: settings.debug.console });

    // Forward warnings/errors to the background log viewer (Options → Logs).
    addLogSink((e) => {
      if ((e.level === 'warn' || e.level === 'error') && contextAlive()) {
        chrome.runtime.sendMessage({ type: 'log', entry: e }).catch(() => {});
      }
    });

    const controller = new Controller(() => settings);
    const unwatch = watchSettingsLite((s) => {
      settings = s;
      configureLogger({ level: s.debug.logLevel, console: s.debug.console });
      controller.applyAppearance(s);
      log.debug('settings updated');
    });

    const isField = (n: EventTarget | null): n is HTMLElement => n instanceof HTMLElement && !!fieldKind(n);
    /** The real focused element, even inside open shadow roots. */
    const realTarget = (e: Event): EventTarget | null => e.composedPath()[0] ?? e.target;

    const onFocusIn = (e: FocusEvent) => {
      const t = realTarget(e);
      if (controller.isOurs(t)) return;
      if (isField(t)) controller.onFocus(t);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (controller.isOurs(realTarget(e))) return;
      controller.onBlur(e.relatedTarget);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (controller.isOurs(realTarget(e))) return;
      if (controller.onKeyDown(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const onInput = (e: Event) => {
      // Only real typing closes the panel; our own inserts are untrusted synthetic or execCommand events.
      if (e.isTrusted && (e as InputEvent).inputType?.startsWith('insert') && !(e as InputEvent).inputType.includes('Replacement')) {
        const t = realTarget(e);
        if (!controller.isOurs(t)) controller.onUserInput(t);
      }
    };
    const onScheme = () => controller.applyAppearance(settings);

    // Capture phase so we see events before page handlers can stop them.
    ctx.addEventListener(document, 'focusin', onFocusIn as EventListener, { capture: true });
    ctx.addEventListener(document, 'focusout', onFocusOut as EventListener, { capture: true });
    ctx.addEventListener(document, 'keydown', onKeyDown as EventListener, { capture: true });
    ctx.addEventListener(document, 'input', onInput, { capture: true });
    ctx.addEventListener(document, 'submit', () => controller.onSubmit(), { capture: true });
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onScheme);

    // The field may already be focused when we load (autofocus).
    const active = document.activeElement;
    if (isField(active)) controller.onFocus(active);

    const onMessage = (msg: TabCommand) => {
      if (msg?.type !== 'command') return;
      // Commands go to every frame; only the focused frame reacts.
      if (!document.hasFocus()) return;
      log.info(`command ${msg.name}`);
      if (msg.name === 'open-suggestions') controller.openForActiveElement();
      else if (msg.name === 'remember') controller.rememberActive();
      else void controller.fillForm();
    };
    chrome.runtime.onMessage.addListener(onMessage);

    ctx.onInvalidated(() => {
      unwatch();
      mq.removeEventListener('change', onScheme);
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* context gone */
      }
      controller.destroy();
    });

    log.debug(`ready in ${window === window.top ? 'top frame' : 'iframe'} ${location.hostname}`);
  },
});
