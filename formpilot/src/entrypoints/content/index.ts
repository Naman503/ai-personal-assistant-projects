import { applyHere, applyNaukriRecommended } from './sites';
import { runOutreach } from './linkedin-outreach';
import { multiApplyResult, siteJobs, sitePushback } from '@/lib/sites';
import { addLogSink, configureLogger, createLogger } from '@/lib/logger';
import { DEFAULTS, loadSettingsLite, watchSettingsLite } from '@/lib/settings-core';
import type { Settings } from '@/lib/settings';
import { deepActiveElement, deepElementFromPoint, fieldKind, shadowOf } from '@/lib/fields/context';
import { Controller, contextAlive } from './controller';
import { ApplyWatcher } from './apply-watch';
import { ApplyWalker } from './walk';
import { ApplyQueue } from './queue';
import { isLinkedInJobList, jobCards } from '@/lib/queue';
import { frameShouldAct } from '@/lib/frames';
import { extractJob } from '@/lib/job';
import { trackError, type TabCommand } from '@/lib/messages';

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
    // Warnings and errors always reach Options → Logs; so do the form-filling steps (each field,
    // each fix, each Next) so a run that went wrong can be read back afterwards.
    const FORWARD_INFO = new Set(['fill', 'fill-form', 'content:walk', 'autopilot:site']);
    addLogSink((e) => {
      if ((e.level === 'warn' || e.level === 'error' || (e.level === 'info' && FORWARD_INFO.has(e.ns))) && contextAlive()) {
        chrome.runtime.sendMessage({ type: 'log', entry: e }).catch(() => {});
      }
    });

    const controller = new Controller(() => settings);
    const watcher = new ApplyWatcher(
      () => ({ on: settings.tracker.enabled && !!settings.tracker.url, autoRecord: settings.tracker.autoRecord, includeAnswers: settings.tracker.includeAnswers }),
      (text, tone, action) => controller.showToast(text, tone, action, action ? 20_000 : tone === 'error' ? 10_000 : 4_000),
    );
    // Walk to Submit: after a fill on a multi-step form, press Next for the user and stop at Submit.
    const walker = new ApplyWalker({
      fill: (anchor) => controller.fillForm('shortcut', { anchor, quiet: true }),
      collect: (scope) => watcher.collect(scope),
      toast: (text, tone, action, ms) => controller.showToast(text, tone, action, ms),
      accent: () => controller.accentColor(),
    });
    const queue = new ApplyQueue({
      prefs: () => ({ cap: settings.tracker.queueDailyCap, delaySec: settings.tracker.queueDelaySec, skipTitles: settings.tracker.queueSkipTitles, autoSubmit: settings.tracker.queueAutoSubmit }),
      fill: (anchor) => controller.fillForm('toolbar', { anchor, quiet: true }),
      walk: (anchor) => walker.run(anchor, { silent: true }),
      blockedReason: () => walker.lastReason || 'This step needs you',
      toast: (text, tone, action, ms) => controller.showToast(text, tone, action, ms),
      dryRecord: (dialog) => watcher.recordDryRun(dialog),
      recordSent: () => watcher.markApplied(),
      aiError: () => controller.takeFillError(),
    });
    controller.afterFill = (anchor) => {
      if (settings.tracker.walkToSubmit) void walker.run(anchor);
    };
    const sharing = () => settings.privacy.shareUsage && !settings.privacy.localOnly;
    /** Our errors only (their stack points into this extension); the page's own errors are never reported. */
    const ours = (e: unknown) => e instanceof Error && !!e.stack?.includes(chrome.runtime.getURL(''));
    const report = (e: unknown, fatal = false) => {
      if (sharing() && contextAlive() && ours(e)) trackError('content', e, fatal);
    };
    /** Wrap a page-event handler: a bug in FormPilot must never break the page, and it gets reported. */
    const guard =
      <A extends unknown[]>(fn: (...a: A) => void) =>
      (...a: A) => {
        try {
          fn(...a);
        } catch (e) {
          log.error('handler failed', e);
          report(e);
        }
      };
    ctx.addEventListener(window, 'error', (e: ErrorEvent) => report(e.error, true));
    ctx.addEventListener(window, 'unhandledrejection', (e: PromiseRejectionEvent) => report(e.reason));
    const unwatch = watchSettingsLite((s) => {
      settings = s;
      configureLogger({ level: s.debug.logLevel, console: s.debug.console });
      controller.applyAppearance(s);
      log.debug('settings updated');
    });

    const isField = (n: EventTarget | null): n is HTMLElement => n instanceof HTMLElement && !!fieldKind(n);
    /** The real focused element, even inside open shadow roots. */
    const realTarget = (e: Event): EventTarget | null => {
      const t = e.composedPath()[0] ?? e.target;
      // Inside a closed shadow root the event only shows us the host: look inside it.
      if (t instanceof Element && shadowOf(t)) {
        if (e instanceof MouseEvent && (e.clientX || e.clientY)) return deepElementFromPoint(e.clientX, e.clientY) ?? t;
        return deepActiveElement() ?? t;
      }
      return t;
    };

    const onFocusIn = guard((e: FocusEvent) => {
      const t = realTarget(e);
      if (controller.isOurs(t)) return;
      if (isField(t)) controller.onFocus(t);
    });
    const onFocusOut = guard((e: FocusEvent) => {
      if (controller.isOurs(realTarget(e))) return;
      controller.onBlur(e.relatedTarget);
    });
    const onKeyDown = guard((e: KeyboardEvent) => {
      if (controller.isOurs(realTarget(e))) return;
      if (controller.onKeyDown(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    });
    const onInput = guard((e: Event) => {
      // Only real typing closes the panel; our own inserts are untrusted synthetic or execCommand events.
      if (e.isTrusted && (e as InputEvent).inputType?.startsWith('insert') && !(e as InputEvent).inputType.includes('Replacement')) {
        const t = realTarget(e);
        if (!controller.isOurs(t)) controller.onUserInput(t);
      }
    });
    const onScheme = () => controller.applyAppearance(settings);

    // Capture phase so we see events before page handlers can stop them.
    ctx.addEventListener(document, 'focusin', onFocusIn as EventListener, { capture: true });
    ctx.addEventListener(document, 'focusout', onFocusOut as EventListener, { capture: true });
    ctx.addEventListener(document, 'keydown', onKeyDown as EventListener, { capture: true });
    ctx.addEventListener(document, 'input', onInput, { capture: true });
    ctx.addEventListener(
      document,
      'submit',
      guard((e: Event) => {
        controller.onSubmit();
        watcher.onSubmit(e.target);
      }),
      { capture: true },
    );
    ctx.addEventListener(
      document,
      'click',
      guard((e: MouseEvent) => {
        const t = realTarget(e);
        if (controller.isOurs(t)) return;
        if (e.isTrusted) watcher.onClick(t);
        if (isField(t)) controller.onFieldClick(t);
      }) as EventListener,
      { capture: true },
    );
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onScheme);

    // Employment dates you pick yourself are remembered per company for the next form.
    document.addEventListener(
      'change',
      (e) => {
        const t = (e.composedPath?.()[0] ?? e.target) as Element | null;
        if (!controller.writing && t && (t.tagName === 'SELECT' || (t as HTMLInputElement).type === 'checkbox')) void controller.rememberWorkDate(t).catch(() => {});
        // Your own answer on a form FormPilot filled: remember it for next time.
        if (!controller.writing && t && e.isTrusted) controller.answerChanged(t);
      },
      true,
    );

    // The field may already be focused when we load (autofocus).
    const active = document.activeElement;
    if (isField(active)) controller.onFocus(active);

    // Naukri's confirmation page after a multi-apply: report Naukri's per-job result to the
    // autopilot (the page that pressed Apply was replaced by this one).
    if (window === window.top && /\/myapply\/saveApply/i.test(location.href)) {
      setTimeout(() => {
        const status = multiApplyResult(location.href) ?? undefined;
        void chrome.runtime.sendMessage({ type: 'autopilot-rec-done', result: { picked: [], outcome: 'sent', reason: 'Naukri confirmed', status } }).catch(() => {});
      }, 1500);
    }
    const onMessage = (msg: TabCommand, _sender: chrome.runtime.MessageSender, reply: (r: unknown) => void) => {
      // LinkedIn outreach: one task on this page, then report back (top frame only).
      if (msg?.type === 'outreach-run') {
        if (window !== window.top) return;
        reply({ ok: true });
        void runOutreach(msg.task).then((result) => chrome.runtime.sendMessage({ type: 'outreach-done', result }).catch(() => {}));
        return;
      }
      if (msg?.type !== 'command') return;
      // Apply queue (LinkedIn job lists): top frame only, no focus needed (the popup has it).
      // Autopilot on Naukri / Cutshort: read the job list, or apply to the job on this page.
      if (msg.name === 'naukri-rec') {
        if (window !== window.top) return;
        reply({ ok: true });
        const o = msg.opts ?? {};
        void applyNaukriRecommended({ max: Math.min(5, o.max ?? 3), dryRun: !!o.dryRun, relevant: o.relevant ?? [], skipWords: o.skipTitles ?? '', maxExpMin: o.maxExpMin ?? 99, seen: o.seen ?? [] })
          .catch((e) => ({ picked: [], outcome: 'skip' as const, reason: `error: ${(e as Error).message}` }))
          .then((result) => chrome.runtime.sendMessage({ type: 'autopilot-rec-done', result }).catch(() => {}));
        return;
      }
      if (msg.name === 'site-list' || msg.name === 'site-apply') {
        if (window !== window.top || !msg.platform) return;
        const push = sitePushback(msg.platform);
        if (msg.name === 'site-list') return void reply({ jobs: siteJobs(msg.platform), pushback: push });
        reply({ ok: true });
        void applyHere(msg.platform, !!msg.opts?.dryRun, (anchor) => controller.fillForm('toolbar', { anchor, quiet: true }))
          .catch((e) => ({ outcome: 'skip' as const, reason: `error: ${(e as Error).message}` }))
          .then((result) => chrome.runtime.sendMessage({ type: 'autopilot-job-done', result }).catch(() => {}));
        return;
      }
      if (msg.name === 'apply-queue-skip-pause') {
        if (window !== window.top) return;
        queue.skipPause();
        reply({ ok: true });
        return;
      }
      if (msg.name === 'apply-queue' || msg.name === 'apply-queue-stop' || msg.name === 'apply-queue-status') {
        if (window !== window.top) return;
        const onList = isLinkedInJobList(location.href) || jobCards().length > 0;
        if (msg.name === 'apply-queue-status') return void reply({ running: queue.active, list: onList });
        if (msg.name === 'apply-queue-stop') queue.stop();
        else if (!onList) controller.showToast('Open a LinkedIn job search (Jobs → search) to use the apply queue.', 'info');
        else if (msg.via === 'autopilot') {
          // The autopilot runs a batch in its own window and wants to know how it went.
          void queue.start({ ...msg.opts }).then((result) => chrome.runtime.sendMessage({ type: 'autopilot-batch-done', result: result ?? { sent: 0, dry: 0, skipped: 0, reason: 'already running' } }).catch(() => {}));
        } else void queue.start();
        reply({ ok: true, list: onList });
        return;
      }
      // Popup asks what job this page shows (top frame only; no description, it's not needed there).
      if (msg.name === 'get-job') {
        if (window !== window.top) return;
        try {
          const { description: _d, ...job } = extractJob();
          reply(job);
        } catch {
          reply(null);
        }
        return;
      }
      // Job tracker actions are about the page, so only the top frame answers (no focus needed).
      if (msg.name === 'save-job' || msg.name === 'mark-applied') {
        if (window !== window.top) return;
        if (!settings.tracker.enabled || !settings.tracker.url) {
          controller.showToast('Turn on the job tracker in FormPilot settings → Behavior first.', 'info');
          return;
        }
        void (msg.name === 'save-job' ? watcher.saveCurrent() : watcher.markApplied());
        return;
      }
      // Commands go to every frame; only the frame the user is in reacts. The toolbar popup and
      // the right-click menu take focus away from the page, so for those: the top frame acts
      // unless the user was inside an iframe, and that iframe acts instead.
      if (!frameShouldAct({ hasFocus: document.hasFocus(), via: msg.via, isTop: window === window.top, activeTag: document.activeElement?.tagName, activeIsField: !!fieldKind(deepActiveElement() ?? document.body) })) return;
      log.info(`command ${msg.name}`);
      const via = msg.via === 'context_menu' ? 'context_menu' : msg.via === 'toolbar' ? 'toolbar' : 'shortcut';
      if (msg.name === 'open-suggestions') controller.openForActiveElement(via === 'context_menu' ? 'context_menu' : 'shortcut');
      else if (msg.name === 'remember') controller.rememberActive(via === 'context_menu' ? 'context_menu' : 'button');
      else void controller.fillForm(via);
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
