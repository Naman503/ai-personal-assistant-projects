/**
 * LinkedIn outreach runner (background). The job tracker is the brain: every few minutes this
 * asks it for one task (GET /api/outreach/next), does it in a quiet tab of its own unfocused
 * window, and reports back (POST /api/outreach/result). The tracker keeps the daily limits,
 * sending hours and dry-run switch, and writes each note right before it is needed.
 *
 * Event-driven with alarms (the service worker sleeps); state lives in chrome.storage.local.
 */
import type { OutreachResult, OutreachTask } from '@/entrypoints/content/linkedin-outreach';
import type { Settings } from './settings';
import { createLogger } from './logger';
import { outreachNext, outreachResult } from './tracker';

const log = createLogger('outreach');
export const OR_KEY = 'fpOutreach';
const TICK = 'fp-or-tick';
const GO = 'fp-or-go';
const WATCHDOG = 'fp-or-watchdog';
const ALL = [TICK, GO, WATCHDOG];

export interface OrState {
  windowId?: number;
  tabId?: number;
  task?: OutreachTask & { startedAt: number; tries: number };
  nextAt?: number;
  message: string;
  history: { t: number; msg: string }[];
}

const rand = (a: number, b: number) => a + Math.random() * Math.max(0, b - a);
const at = (name: string, when: number) => chrome.alarms.create(name, { when: Math.max(Date.now() + 1000, when) });
const fmt = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

async function load(): Promise<OrState> {
  const got = (await chrome.storage.local.get(OR_KEY))[OR_KEY] as OrState | undefined;
  return { message: 'Not running', history: [], ...(got ?? {}) };
}
async function save(st: OrState, msg?: string) {
  if (msg) {
    st.message = msg;
    st.history = [...st.history, { t: Date.now(), msg }].slice(-60);
    log.info(msg);
  }
  await chrome.storage.local.set({ [OR_KEY]: st });
}

const describe = (t: OutreachTask) =>
  t.task === 'find-people' ? `Reading the hiring team: ${t.role ?? 'job'} · ${t.company ?? ''}` : t.task === 'connect' ? `Connecting with ${t.name ?? 'someone'}` : t.task === 'check' ? `Checking if ${t.name ?? 'someone'} accepted` : `Messaging ${t.name ?? 'someone'}`;

export class Outreach {
  constructor(private settings: () => Settings) {}

  private on() {
    const t = this.settings().tracker;
    return t.enabled && t.outreach && !!t.url;
  }

  status() {
    return load();
  }

  /** Settings changed or the worker started: make sure a tick is scheduled (or everything stopped). */
  async sync() {
    if (!this.on()) return this.stop('Outreach is off');
    const alarms = await Promise.all(ALL.map((a) => chrome.alarms.get(a)));
    if (alarms.some(Boolean)) return;
    await at(TICK, Date.now() + 60_000);
    const st = await load();
    st.task = undefined;
    st.nextAt = Date.now() + 60_000;
    await save(st, 'Outreach on; first check in a minute');
  }

  async stop(reason: string) {
    await Promise.all(ALL.map((a) => chrome.alarms.clear(a)));
    const st = await load();
    if (st.windowId !== undefined) await chrome.windows.remove(st.windowId).catch(() => {});
    const had = st.windowId !== undefined || st.task || st.nextAt;
    st.windowId = st.tabId = st.task = st.nextAt = undefined;
    await save(st, had ? reason : undefined);
  }

  async runNow() {
    if (!this.on()) return;
    await chrome.alarms.clear(TICK);
    await this.tick();
  }

  async onAlarm(name: string) {
    if (name === TICK) await this.tick();
    else if (name === GO) await this.go();
    else if (name === WATCHDOG) await this.done({ outcome: 'failed', detail: 'the page took too long' });
  }

  private async later(st: OrState, mins: number, msg: string) {
    const next = Date.now() + mins * 60_000;
    st.nextAt = next;
    st.task = undefined;
    await at(TICK, next);
    await save(st, `${msg}. Next check at ${fmt(next)}`);
  }

  private async tick() {
    if (!this.on()) return this.stop('Outreach is off');
    const st = await load();
    if (st.task) return;
    let task: OutreachTask | { task: 'none'; reason?: string; retry?: boolean };
    try {
      task = await outreachNext(this.settings().tracker.url);
    } catch (e) {
      return this.later(st, 15, `Couldn't reach the tracker (${(e as Error).message})`);
    }
    if (task.task === 'none') {
      const quiet = /outside|limit|paused|off/i.test(task.reason ?? '');
      return this.later(st, quiet ? rand(25, 40) : rand(8, 15), task.reason ?? 'Nothing to do');
    }
    const url = task.task === 'find-people' ? task.url : task.profile;
    const tabId = await this.ensureTab(st, url);
    if (tabId === undefined) return this.later(st, 10, "Couldn't open the outreach window");
    st.task = { ...task, startedAt: Date.now(), tries: 0 };
    st.nextAt = undefined;
    // Let the page load like a person would wait for it.
    await at(GO, Date.now() + rand(30, 45) * 1000);
    await at(WATCHDOG, Date.now() + 4 * 60_000);
    await save(st, describe(task));
  }

  private async ensureTab(st: OrState, url: string): Promise<number | undefined> {
    if (st.tabId !== undefined) {
      const tab = await chrome.tabs.get(st.tabId).catch(() => null);
      if (tab) {
        await chrome.tabs.update(st.tabId, { url });
        return st.tabId;
      }
    }
    const win = await chrome.windows.create({ url, focused: false, type: 'normal', state: 'normal', width: 1200, height: 900 }).catch(() => null);
    const tabId = win?.tabs?.[0]?.id;
    if (!win || tabId === undefined) return undefined;
    st.windowId = win.id;
    st.tabId = tabId;
    return tabId;
  }

  private async go() {
    const st = await load();
    if (!st.task || st.tabId === undefined) return;
    const { startedAt: _s, tries: _t, ...task } = st.task;
    const ok = await chrome.tabs.sendMessage(st.tabId, { type: 'outreach-run', task }, { frameId: 0 }).catch(() => null);
    if (!ok) {
      if (++st.task.tries < 2) {
        await at(GO, Date.now() + 30_000);
        return save(st);
      }
      return this.done({ outcome: 'failed', detail: "FormPilot couldn't reach the page" });
    }
  }

  /** The page finished the task (or it timed out): report it and pick the next pause. */
  async done(result: OutreachResult, tabId?: number) {
    const st = await load();
    const t = st.task;
    if (!t || (tabId !== undefined && tabId !== st.tabId)) return;
    await Promise.all([GO, WATCHDOG].map((a) => chrome.alarms.clear(a)));
    try {
      await outreachResult(this.settings().tracker.url, t.task === 'find-people' ? { task: t.task, appId: t.appId, people: result.people ?? [], outcome: result.outcome } : { task: t.task, id: t.id, outcome: result.outcome, detail: result.detail ?? '' });
    } catch (e) {
      log.warn('could not report to the tracker', e);
    }
    if (st.tabId !== undefined) await chrome.tabs.update(st.tabId, { url: 'about:blank' }).catch(() => {});
    const what = `${describe(t)}: ${result.outcome}${result.detail ? ` (${result.detail})` : ''}${t.task === 'find-people' ? `, ${result.people?.length ?? 0} found` : ''}`;
    if (result.outcome === 'limit') return this.later(st, 6 * 60, `${what}. Pausing outreach`);
    // A person-like gap: longer after something was actually sent.
    const sent = /sent|dry/.test(result.outcome);
    return this.later(st, sent ? rand(4, 9) : rand(1.5, 3), what);
  }

  async onWindowRemoved(windowId: number) {
    const st = await load();
    if (windowId !== st.windowId) return;
    st.windowId = st.tabId = undefined;
    if (st.task) {
      await save(st);
      return this.done({ outcome: 'failed', detail: 'the outreach window was closed' });
    }
    await save(st);
  }
}
