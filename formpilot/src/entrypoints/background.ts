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
import { providerFamily, UsageReporter, usageSource } from '@/lib/usage';

export default defineBackground({
  type: 'module',
  main() {
    const ring = new LogRing(1500);
    configureLogger({ context: 'bg' });
    addLogSink((e) => ring.push(e));
    const log = createLogger('bg');

    let settings: Settings = DEFAULT_SETTINGS;
    const engine = new SuggestEngine(() => settings);
    const usage = new UsageReporter(() => settings);
    const usageDaily = () => {
      const active = activeProviders(settings);
      return {
        facts: { model_used: { provider: providerFamily(active[0]) } } as Record<string, Record<string, string>>,
        setup: active.length ? ['setup_provider'] : [],
      };
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
        void usage.count('popup_opened');
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
          return null;
        case 'get-logs':
          return ring.all();
        case 'clear-logs':
          ring.clear();
          return null;
        case 'accept':
          counters.accepted++;
          void usage.count('fields_filled', { source: usageSource(msg.source) });
          void usage.once('first_fill');
          if (settings.cache.history && msg.text.trim()) {
            await recordAccepted(msg.field, msg.text, msg.host);
            invalidateHistoryCache();
          }
          return null;
        case 'learn':
          void usage.event('correction_saved');
          return engine.learn(msg.field, msg.text, msg.host, settings.cache.learnSaveAs);
        case 'fill-form': {
          const signal = AbortSignal.timeout(Math.max(settings.generation.timeoutMs, 60_000));
          const out = await engine.fillForm(msg.fields, msg.page, signal);
          void usage.event('form_filled');
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
          const r = await adapterFor(p).generate(await resolveProvider(p), {
            system: 'You are a connectivity test. Reply with JSON only.',
            prompt: 'Return {"suggestions":[{"title":"ok","text":"FormPilot is connected"}]}',
            schema: { type: 'object', properties: { suggestions: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } } } } } },
            temperature: 0,
            maxTokens: 200,
            thinking: 'off',
            stream: false,
            signal: AbortSignal.timeout(30_000),
          });
          return { ms: Math.round(performance.now() - t0), model: r.model, sample: r.text.slice(0, 200) };
        }
        case 'list-models': {
          const p = msg.provider ?? settings.providers.find((x) => x.id === msg.providerId);
          if (!p) throw new LLMError('no-provider', 'Unknown provider');
          return adapterFor(p).listModels(await resolveProvider(p), AbortSignal.timeout(15_000));
        }
        case 'chrome-ai-status':
          return chromeAiAvailability(true);
        case 'memory-changed':
          engine.index.invalidate();
          invalidateHistoryCache();
          if (msg.docId && msg.extractFacts) {
            void usage.event('document_added');
            void usage.once('setup_document');
          }
          if (msg.docId && msg.extractFacts && settings.memory.autoExtractFacts) {
            void engine.extractFacts(msg.docId);
          }
          if (settings.memory.useEmbeddings) void engine.embedPending().catch((e) => log.warn('embedding failed', e));
          return null;
        case 'extract-facts':
          return engine.extractFacts(msg.docId);
        case 'search-memory': {
          const q = msg.query.trim();
          if (!q) return { chunks: [], whole: false, ms: 0 };
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
          if (msg.what !== 'history') await cacheClear();
          if (msg.what !== 'responses') {
            await db().history.clear();
            invalidateHistoryCache();
          }
          return null;
        case 'open-options': {
          const url = chrome.runtime.getURL('options.html') + (msg.section ? `#${msg.section}` : '');
          const [existing] = await chrome.tabs.query({ url: chrome.runtime.getURL('options.html') + '*' });
          if (existing?.id) {
            await chrome.tabs.update(existing.id, { active: true, url });
            if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
          } else await chrome.tabs.create({ url });
          return null;
        }
        case 'site-toggle': {
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
          sendResponse({ ok: false, error: info } satisfies RpcResponse);
        },
      );
      return true;
    });

    // ---------- Commands, context menu, install ----------
    async function sendCommand(tabId: number, name: CommandName, frameId?: number) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'command', name }, frameId !== undefined ? { frameId } : undefined);
      } catch (e) {
        log.warn(`could not reach the page for "${name}". Refresh the tab once after installing or updating FormPilot.`, e);
      }
    }

    chrome.commands.onCommand.addListener(async (command) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      log.info(`command: ${command}`);
      if (tab?.id && (command === 'open-suggestions' || command === 'fill-form')) await sendCommand(tab.id, command);
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
      void sendCommand(tab.id, name, info.frameId);
    });
  },
});
