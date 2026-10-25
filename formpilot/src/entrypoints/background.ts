import { addLogSink, configureLogger, createLogger, LogRing } from '@/lib/logger';
import { DEFAULT_SETTINGS, loadSettings, watchSettings, patchSettings, type Settings } from '@/lib/settings';
import { SUGGEST_PORT, type CommandName, type PortEvent, type PortRequest, type RpcRequest, type RpcResponse, type Stats } from '@/lib/messages';
import { SuggestEngine, counters } from '@/lib/engine/suggest';
import { recordAccepted, invalidateHistoryCache } from '@/lib/engine/history';
import { cacheClear, cacheCount, cachePrune } from '@/lib/engine/cache';
import { activeProviders, adapterFor, resetCooldowns, resolveProvider } from '@/lib/llm/registry';
import { installVaultCacheInvalidation } from '@/lib/vault';
import { chromeAiAvailability, installChromeAiRelay } from '@/lib/llm/chrome-ai';
import { ollamaOriginRule } from '@/lib/llm/ollama';
import { LLMError } from '@/lib/llm/types';
import { db } from '@/lib/memory/db';
import { hostMatches, isAbort } from '@/lib/util';
import { charsBucket, countBucket, docKind, errorCategory, msBucket, providerFamily, sanitizeClientEvent, optionsSection, settingsSnapshot, UsageReporter, usageSource } from '@/lib/usage';
import { vaultStatus } from '@/lib/vault';

export default defineBackground({
  type: 'module',
  main() {
    const ring = new LogRing(1500);
    configureLogger({ context: 'bg' });
    addLogSink((e) => ring.push(e));
    const log = createLogger('bg');

    let settings: Settings = DEFAULT_SETTINGS;
    const usage = new UsageReporter(() => settings);
    const engine = new SuggestEngine(() => settings, usage);
    /** Once a day: provider mix, memory size and a settings snapshot (enums, booleans, buckets only). */
    const usageDaily = async () => {
      const active = activeProviders(settings);
      const facts: Record<string, Record<string, string | number | boolean>> = {
        model_used: { provider: providerFamily(active[0]) },
        ...settingsSnapshot(settings),
      };
      const vault = await vaultStatus().catch(() => null);
      // Only ask Chrome (it opens the offscreen page) when Chrome AI is switched on.
      const nanoOn = settings.providers.some((p) => p.kind === 'chrome-ai' && p.enabled);
      const nano = nanoOn ? await chromeAiAvailability().catch(() => 'error') : 'off';
      facts.providers_configured = {
        active: active.length,
        first: providerFamily(active[0]),
        second: active[1] ? providerFamily(active[1]) : 'none',
        local: active.some((p) => p.kind === 'ollama' || p.kind === 'chrome-ai' || /localhost|127\.0\.0\.1/.test(p.baseUrl)),
        chrome_ai: ['off', 'available', 'downloadable', 'downloading', 'unavailable', 'no-api'].includes(String(nano)) ? String(nano).replace('-', '_') : 'other',
        vault: vault?.exists ? vault.mode : 'none',
        vault_usable: !!vault?.usable,
        saved_keys: countBucket(settings.providers.filter((p) => p.hasKey).length),
      };
      try {
        await engine.index.ensure();
        facts.memory_size = {
          docs: countBucket(await db().docs.count()),
          facts: countBucket(await db().facts.count()),
          history: countBucket(await db().history.count()),
          cache: countBucket(await cacheCount()),
          chars: charsBucket(engine.index.totalChars),
        };
      } catch (e) {
        log.debug('memory size not counted', e);
      }
      return { facts, setup: active.length ? ['setup_provider'] : [] };
    };
    const flushUsage = () => usage.flush(usageDaily).catch((e) => log.debug('usage report not sent', e));

    const applySettings = (s: Settings) => {
      settings = s;
      configureLogger({ level: s.debug.logLevel, console: s.debug.console });
      resetCooldowns();
      void syncOllamaRules(s);
    };
    const ready = loadSettings().then((s) => {
      applySettings(s);
      void usage.checkVersion(chrome.runtime.getManifest().version);
      log.info(`service worker ready · ${s.providers.filter((p) => p.enabled).map((p) => p.label).join(', ')}`);
    });
    watchSettings((s) => {
      log.debug('settings changed');
      const wasSharing = settings.privacy.shareUsage;
      applySettings(s);
      if (wasSharing && !s.privacy.shareUsage) void usage.turnedOff();
      else if (!wasSharing && s.privacy.shareUsage) void usage.turnedOn();
    });

    // ---------- Anonymous usage: sent every 6 hours, and soon after the worker starts ----------
    // First send after 10 minutes, so short test runs (Playwright in CI) never report.
    chrome.alarms?.create('usage', { delayInMinutes: 10, periodInMinutes: 360 });
    chrome.alarms?.onAlarm.addListener((a) => {
      if (a.name === 'usage') void ready.then(flushUsage);
    });
    self.addEventListener('error', (e) => void usage.error((e as ErrorEvent).error, true));
    self.addEventListener('unhandledrejection', (e) => {
      if (!isAbort((e as PromiseRejectionEvent).reason)) void usage.error((e as PromiseRejectionEvent).reason);
    });

    installChromeAiRelay();
    installVaultCacheInvalidation();

    // ---------- Ollama Origin fix (declarativeNetRequest) ----------
    async function syncOllamaRules(s: Settings) {
      if (!chrome.declarativeNetRequest) return;
      try {
        const existing = await chrome.declarativeNetRequest.getDynamicRules();
        const rules = s.providers
          .filter((p) => p.kind === 'ollama' && p.baseUrl)
          .map((p, i) => ollamaOriginRule(p.baseUrl, chrome.runtime.id, 100 + i))
          .filter(Boolean) as chrome.declarativeNetRequest.Rule[];
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: existing.map((r) => r.id),
          addRules: rules,
        });
        if (rules.length) log.debug(`ollama origin rules installed for ${rules.length} endpoint(s)`);
      } catch (e) {
        log.warn('could not install Ollama origin rule', e);
      }
    }

    // ---------- Streaming suggestions over a port ----------
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== SUGGEST_PORT) return;
      const tabHost = (() => {
        try {
          return new URL(port.sender?.url ?? '').hostname;
        } catch {
          return '';
        }
      })();
      const inflight = new Map<string, AbortController>();
      let alive = true;
      const emit = (e: PortEvent) => {
        if (!alive) return;
        try {
          port.postMessage(e);
        } catch {
          alive = false;
        }
      };
      port.onDisconnect.addListener(() => {
        alive = false;
        for (const c of inflight.values()) c.abort();
        inflight.clear();
      });
      port.onMessage.addListener(async (msg: PortRequest) => {
        await ready;
        if (msg.type === 'cancel') {
          inflight.get(msg.reqId)?.abort();
          inflight.delete(msg.reqId);
          return;
        }
        if (msg.type !== 'suggest') return;
        // Every open starts with an instant lookup, so that is one popup open.
        if (msg.opts?.instantOnly) {
          const t = msg.opts.trigger ?? 'auto';
          void usage.count('popup_opened', { trigger: ['auto', 'icon', 'shortcut', 'context_menu', 'alt_down', 'click_reopen', 'chat_question'].includes(t) ? t : 'other' });
        }
        // One active request per port (per frame): moving focus cancels the previous one.
        for (const c of inflight.values()) c.abort();
        inflight.clear();
        const ctl = new AbortController();
        inflight.set(msg.reqId, ctl);
        const signal = AbortSignal.any([ctl.signal, AbortSignal.timeout(settings.generation.timeoutMs)]);
        log.debug(`port request ${msg.reqId} from ${tabHost}`);
        try {
          await engine.suggest(msg.reqId, msg.field, msg.page, msg.opts ?? {}, signal, emit, msg.constraints);
        } catch (e) {
          if (!isAbort(e)) {
            log.error('suggest crashed', e);
            void usage.error(e);
            void usage.count('suggest_result', { outcome: 'crash' });
            emit({ type: 'error', reqId: msg.reqId, error: { code: 'unknown', message: (e as Error).message } });
          }
        } finally {
          inflight.delete(msg.reqId);
        }
      });
    });

    // ---------- RPC ----------
    async function handle(msg: RpcRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
      await ready;
      switch (msg.type) {
        case 'log':
          ring.push({ ...msg.entry, ctx: `content:${new URL(sender.url ?? 'about:blank').hostname}` });
          // Only the level is counted, never the text.
          if (msg.entry.level === 'error' || msg.entry.level === 'warn') void usage.count('content_log', { level: msg.entry.level });
          return null;
        case 'usage': {
          const ev = sanitizeClientEvent(msg.name, msg.props);
          if (!ev) return null;
          if (ev.counter) void usage.count(ev.name, ev.props);
          else void usage.event(ev.name, Object.keys(ev.props).length ? ev.props : undefined);
          if (ev.name === 'suggestions_shown' && ev.props.first === 'ai') void usage.once('first_ai_suggestion');
          return null;
        }
        case 'usage-error':
          if (['content', 'options', 'popup', 'offscreen'].includes(msg.where) && typeof msg.name === 'string') {
            void usage.crash(msg.name, typeof msg.stack === 'string' ? msg.stack : undefined, !!msg.fatal, msg.where);
          }
          return null;
        case 'get-logs':
          return ring.all();
        case 'clear-logs':
          ring.clear();
          return null;
        case 'accept':
          counters.accepted++;
          void usage.count('fields_filled', { source: usageSource(msg.source) });
          void usage.count('suggestion_accepted', {
            source: usageSource(msg.source),
            method: ['click', 'enter', 'tab', 'alt_number'].includes(msg.method ?? '') ? msg.method! : 'other',
            rank: Math.min(Math.max(Math.round(Number(msg.rank) || 0), 0), 9),
            long_form: !!msg.field.longForm,
            chat: !!msg.field.chat,
          });
          void usage.once('first_fill');
          if (settings.cache.history && msg.text.trim()) {
            await recordAccepted(msg.field, msg.text, msg.host);
            invalidateHistoryCache();
          }
          return null;
        case 'learn': {
          const out = await engine.learn(msg.field, msg.text, msg.host, settings.cache.learnSaveAs);
          void usage.event('correction_saved', {
            trigger: ['ask', 'auto', 'button', 'context_menu'].includes(msg.trigger ?? '') ? msg.trigger! : 'other',
            saved_as: out.savedAs.includes('fact') ? 'fact' : out.savedAs.includes('note') ? 'note' : out.savedAs.length ? 'answer' : 'nothing',
          });
          void usage.once('first_correction');
          return out;
        }
        case 'fill-form': {
          const signal = AbortSignal.timeout(Math.max(settings.generation.timeoutMs, 60_000));
          const trigger = ['shortcut', 'context_menu', 'popup_menu', 'toolbar'].includes(msg.trigger ?? '') ? msg.trigger! : 'other';
          let out: Awaited<ReturnType<typeof engine.fillForm>>;
          try {
            out = await engine.fillForm(msg.fields, msg.page, signal);
          } catch (e) {
            const category = isAbort(e) ? 'timeout' : errorCategory((e as LLMError)?.code);
            void usage.count('ai_error', { op: 'form', category, provider: providerFamily(activeProviders(settings)[0]) });
            void usage.event('form_fill_failed', { category, trigger, fields: countBucket(msg.fields.length) });
            throw e;
          }
          const answered = Object.keys(out.values).length;
          const fromFacts = Object.values(out.sources).filter((x) => x === 'fact').length;
          void usage.event('form_filled', {
            trigger,
            fields: countBucket(msg.fields.length),
            answered: countBucket(answered),
            from_memory: countBucket(fromFacts),
            from_ai: countBucket(answered - fromFacts),
            latency: msBucket(out.ms),
          });
          void usage.once('first_form_fill');
          const bySource: Record<string, number> = {};
          for (const src of Object.values((out as { sources?: Record<string, string> }).sources ?? {})) {
            const k = usageSource(src);
            bySource[k] = (bySource[k] ?? 0) + 1;
          }
          for (const [source, n] of Object.entries(bySource)) void usage.count('fields_filled', { source }, n);
          if (Object.keys(bySource).length) void usage.once('first_fill');
          return out;
        }
        case 'test-provider': {
          // The options page sends the live (possibly unsaved) config so "Test" works right after typing a key.
          const p = msg.provider ?? settings.providers.find((x) => x.id === msg.providerId);
          if (!p) throw new LLMError('no-provider', 'Unknown provider');
          const t0 = performance.now();
          const tested = (result: string) =>
            void usage.count('provider_tested', { provider: providerFamily(p), result, latency: msBucket(performance.now() - t0) });
          const r = await adapterFor(p).generate(await resolveProvider(p), {
            system: 'You are a connectivity test. Reply with JSON only.',
            prompt: 'Return {"suggestions":[{"title":"ok","text":"FormPilot is connected"}]}',
            schema: { type: 'object', properties: { suggestions: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } } } } } },
            temperature: 0,
            maxTokens: 200,
            thinking: 'off',
            stream: false,
            signal: AbortSignal.timeout(30_000),
          }).catch((e) => {
            tested(isAbort(e) ? 'timeout' : errorCategory((e as LLMError)?.code));
            throw e;
          });
          tested('ok');
          return { ms: Math.round(performance.now() - t0), model: r.model, sample: r.text.slice(0, 200) };
        }
        case 'list-models': {
          const p = msg.provider ?? settings.providers.find((x) => x.id === msg.providerId);
          if (!p) throw new LLMError('no-provider', 'Unknown provider');
          try {
            const models = await adapterFor(p).listModels(await resolveProvider(p), AbortSignal.timeout(15_000));
            void usage.count('models_listed', { provider: providerFamily(p), result: 'ok', models: countBucket(models.length) });
            return models;
          } catch (e) {
            void usage.count('models_listed', { provider: providerFamily(p), result: isAbort(e) ? 'timeout' : errorCategory((e as LLMError)?.code) });
            throw e;
          }
        }
        case 'chrome-ai-status':
          return chromeAiAvailability(true);
        case 'memory-changed':
          engine.index.invalidate();
          invalidateHistoryCache();
          if (msg.docId && msg.extractFacts && msg.isNew !== false) {
            void usage.event('document_added', { type: docKind(msg.docKind) });
            void usage.once('setup_document');
          }
          if (msg.docId && msg.extractFacts && settings.memory.autoExtractFacts) {
            void engine.extractFacts(msg.docId);
          }
          if (settings.memory.useEmbeddings) {
            void engine.embedPending().then(
              (n) => n && void usage.count('embeddings_run', { result: 'ok', chunks: countBucket(n) }),
              (e) => {
                log.warn('embedding failed', e);
                void usage.count('embeddings_run', { result: errorCategory((e as LLMError)?.code) });
              },
            );
          }
          return null;
        case 'extract-facts':
          return engine.extractFacts(msg.docId, undefined, 'manual');
        case 'search-memory': {
          const q = msg.query.trim();
          if (!q) return { chunks: [], whole: false, ms: 0 };
          void usage.count('options_action', { action: 'memory_search' });
          return engine.index.search(q, { topK: settings.memory.topK, budget: settings.memory.contextBudgetChars });
        }
        case 'stats': {
          await engine.index.ensure();
          const s: Stats = {
            docs: await db().docs.count(),
            chunks: await db().chunks.count(),
            facts: await db().facts.count(),
            history: await db().history.count(),
            cache: await cacheCount(),
            memoryChars: engine.index.totalChars,
            counters: { ...counters },
          };
          return s;
        }
        case 'clear-cache':
          void usage.count('cache_cleared', { what: ['responses', 'history', 'all'].includes(msg.what) ? msg.what : 'other' });
          if (msg.what !== 'history') await cacheClear();
          if (msg.what !== 'responses') {
            await db().history.clear();
            invalidateHistoryCache();
          }
          return null;
        case 'open-options': {
          void usage.count('settings_opened_from', { from: sender.tab ? 'page_popup' : 'toolbar', section: optionsSection(msg.section) });
          const url = chrome.runtime.getURL('options.html') + (msg.section ? `#${msg.section}` : '');
          const [existing] = await chrome.tabs.query({ url: chrome.runtime.getURL('options.html') + '*' });
          if (existing?.id) {
            await chrome.tabs.update(existing.id, { active: true, url });
            if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
          } else await chrome.tabs.create({ url });
          return null;
        }
        case 'site-toggle': {
          void usage.count('site_toggled', { enabled: !!msg.enabled, from: 'page_popup' });
          await patchSettings((s) => {
            const list = s.behavior.blockedSites.filter((h) => !hostMatches(msg.host, h));
            s.behavior.blockedSites = msg.enabled ? list : [...list, msg.host];
          });
          return null;
        }
      }
    }

    chrome.runtime.onMessage.addListener((msg: RpcRequest & { target?: string }, sender, sendResponse) => {
      if (msg?.target) return false; // offscreen/relay traffic
      if (!msg || typeof msg.type !== 'string') return false;
      handle(msg, sender).then(
        (data) => sendResponse({ ok: true, data } satisfies RpcResponse),
        (e) => {
          const info = e instanceof LLMError ? e.toInfo() : { code: 'unknown' as const, message: (e as Error)?.message ?? String(e) };
          if (msg.type !== 'log') log.warn(`rpc ${msg.type} failed: ${info.message}`);
          if (msg.type !== 'log' && msg.type !== 'usage' && msg.type !== 'usage-error') void usage.count('rpc_failed', { type: msg.type, code: errorCategory(info.code) });
          sendResponse({ ok: false, error: info } satisfies RpcResponse);
        },
      );
      return true;
    });

    // ---------- Commands, context menu, install ----------
    async function sendCommand(tabId: number, name: CommandName, via: 'shortcut' | 'context_menu', frameId?: number) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'command', name, via }, frameId !== undefined ? { frameId } : undefined);
      } catch (e) {
        void usage.count('command_unreachable', { via });
        log.warn(`could not reach the page for "${name}". Refresh the tab once after installing or updating FormPilot.`, e);
      }
    }

    chrome.commands.onCommand.addListener(async (command) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      log.info(`command: ${command}`);
      if (command === 'open-suggestions' || command === 'fill-form') void usage.count('shortcut_used', { command: command.replace('-', '_') });
      if (tab?.id && (command === 'open-suggestions' || command === 'fill-form')) await sendCommand(tab.id, command, 'shortcut');
    });

    chrome.runtime.onInstalled.addListener(async (details) => {
      chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: 'fp-suggest', title: 'FormPilot: suggest for this field', contexts: ['editable'] });
        chrome.contextMenus.create({ id: 'fp-fill', title: 'FormPilot: fill the whole form', contexts: ['editable'] });
        chrome.contextMenus.create({ id: 'fp-remember', title: 'FormPilot: remember my answer for this field', contexts: ['editable'] });
      });
      if (details.reason === 'install') await chrome.runtime.openOptionsPage();
      const s = await loadSettings();
      await cachePrune(s.cache.responseCacheTtlHours * 3600_000).catch(() => 0);
      log.info(`installed/updated (${details.reason}) · v${chrome.runtime.getManifest().version}`);
    });

    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (!tab?.id) return;
      const name: CommandName = info.menuItemId === 'fp-fill' ? 'fill-form' : info.menuItemId === 'fp-remember' ? 'remember' : 'open-suggestions';
      void usage.count('context_menu_used', { item: name.replace('-', '_') });
      void sendCommand(tab.id, name, 'context_menu', info.frameId);
    });
  },
});
