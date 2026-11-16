/**
 * Autopilot runner (background). Opens its own Brave window (unfocused, so your work isn't
 * interrupted), and every 20–40 minutes inside active hours runs one small batch of the apply
 * queue there on a LinkedIn search for the next job title. Event-driven (alarms + messages),
 * because the service worker sleeps between batches; all state is in chrome.storage.local.
 */
import type { Settings } from './settings';
import { batchSize, freshDay, gapMinutes, inActiveHours, ist, linkedInSearchUrl, nextStart, pickTitle, titlesOf, type DayState } from './autopilot';
import { createLogger } from './logger';
import { relevantWords } from './queue';

const log = createLogger('autopilot');
export const AP_KEY = 'fpAutopilot';
const TICK = 'fp-ap-tick';
const GO = 'fp-ap-go';
const WATCHDOG = 'fp-ap-watchdog';

export type Phase = 'stopped' | 'loading' | 'batch' | 'waiting' | 'outside-hours' | 'done-today';

export interface ApState {
  running: boolean;
  phase: Phase;
  windowId?: number;
  tabId?: number;
  day: DayState;
  lastTitle: number;
  current?: { title: string; index: number; batch: number; startedAt: number; tries: number };
  nextAt?: number;
  message: string;
  history: { t: number; msg: string }[];
}

const blank = (): ApState => ({ running: false, phase: 'stopped', day: freshDay(ist().date), lastTitle: -1, message: 'Not running', history: [] });

export async function loadState(): Promise<ApState> {
  const got = (await chrome.storage.local.get(AP_KEY))[AP_KEY] as ApState | undefined;
  return got ? { ...blank(), ...got } : blank();
}

async function save(st: ApState, msg?: string) {
  if (msg) {
    st.message = msg;
    st.history = [...st.history, { t: Date.now(), msg }].slice(-60);
    log.info(msg);
  }
  await chrome.storage.local.set({ [AP_KEY]: st });
  void chrome.action.setBadgeText({ text: st.running ? (st.phase === 'batch' || st.phase === 'loading' ? 'AP' : 'ap') : '' }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ color: '#16a34a' }).catch(() => {});
}

const at = (name: string, when: number) => chrome.alarms.create(name, { when: Math.max(Date.now() + 1000, when) });
const fmt = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

function newDay(st: ApState) {
  const today = ist().date;
  if (st.day.date !== today) st.day = freshDay(today);
}

/** Start of tomorrow's active hours (or the next active day). */
function tomorrowStart(ap: Settings['autopilot']): Date {
  const endOfToday = Date.parse(`${ist().date}T23:59:00Z`) - 330 * 60_000 + 120_000;
  return nextStart(ap, new Date(endOfToday));
}

function notify(title: string, message: string) {
  try {
    chrome.notifications?.create(`fp-ap-${Date.now()}`, { type: 'basic', iconUrl: chrome.runtime.getURL('icon/128.png'), title, message, priority: 2 });
  } catch {
    /* notifications unavailable */
  }
}

export class Autopilot {
  constructor(private settings: () => Settings) {}

  status() {
    return loadState();
  }

  async start() {
    const st = await loadState();
    newDay(st);
    st.running = true;
    st.phase = 'waiting';
    await save(st, `Autopilot started${this.settings().autopilot.dryRun ? ' (dry run: nothing is sent)' : ''}`);
    await this.tick();
  }

  async stop(reason = 'Stopped by you', alert = false) {
    const st = await loadState();
    if (st.tabId !== undefined) await chrome.tabs.sendMessage(st.tabId, { type: 'command', name: 'apply-queue-stop' }, { frameId: 0 }).catch(() => {});
    await Promise.all([TICK, GO, WATCHDOG].map((a) => chrome.alarms.clear(a)));
    try {
      chrome.power?.releaseKeepAwake();
    } catch {
      /* ignore */
    }
    st.running = false;
    st.phase = 'stopped';
    st.current = undefined;
    st.nextAt = undefined;
    await save(st, reason);
    if (alert) {
      notify('FormPilot autopilot stopped', reason);
      void chrome.action.setBadgeText({ text: '!' }).catch(() => {});
      void chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }).catch(() => {});
    }
  }

  /** Run a batch now (from the popup), even if the next one was scheduled later. */
  async runNow() {
    const st = await loadState();
    if (!st.running) return this.start();
    if (st.current) return;
    await this.tick(true);
  }

  async onAlarm(name: string) {
    if (name === TICK) await this.tick();
    else if (name === GO) await this.go();
    else if (name === WATCHDOG) await this.watchdog();
  }

  /** Decide what to do now: wait for active hours, stop for the day, or start a batch. */
  private async tick(force = false) {
    const ap = this.settings().autopilot;
    const st = await loadState();
    if (!st.running || st.current) return;
    newDay(st);
    if (!force && !inActiveHours(ap)) {
      const next = nextStart(ap).getTime();
      st.phase = 'outside-hours';
      st.nextAt = next;
      try {
        chrome.power?.releaseKeepAwake();
      } catch {
        /* ignore */
      }
      await at(TICK, next);
      return save(st, `Outside active hours; next batch at ${fmt(next)}`);
    }
    const titles = titlesOf(ap);
    const done = st.day.sent + st.day.dry >= ap.dailyCap;
    const pick = done ? null : pickTitle(titles, st.day, ap.perTitleCap, st.lastTitle);
    const size = pick ? batchSize(ap, st.day, pick.title) : 0;
    if (!pick || !size) {
      const next = tomorrowStart(ap).getTime();
      st.phase = 'done-today';
      st.nextAt = next;
      await at(TICK, next);
      return save(st, done ? `Daily limit reached (${ap.dailyCap}). Back at ${fmt(next)} tomorrow` : `No titles left to search today. Back at ${fmt(next)}`);
    }
    try {
      chrome.power?.requestKeepAwake('display'); // a sleeping display hides the window and Brave slows it down
    } catch {
      /* ignore */
    }
    const url = linkedInSearchUrl(pick.title, ap);
    const tabId = await this.ensureTab(st, url);
    if (tabId === undefined) return this.stop("Couldn't open the autopilot window", true);
    st.current = { title: pick.title, index: pick.index, batch: size, startedAt: Date.now(), tries: 0 };
    st.phase = 'loading';
    st.nextAt = undefined;
    await at(GO, Date.now() + 30_000); // let LinkedIn load the list
    await at(WATCHDOG, Date.now() + 50 * 60_000);
    await save(st, `Searching LinkedIn for "${pick.title}" (batch of ${size}${ap.dryRun ? ', dry run' : ''})`);
  }

  /** The autopilot's own window: reuse it, or open a new one without taking focus. */
  private async ensureTab(st: ApState, url: string): Promise<number | undefined> {
    if (st.tabId !== undefined) {
      const tab = await chrome.tabs.get(st.tabId).catch(() => null);
      if (tab && tab.windowId === st.windowId) {
        await chrome.tabs.update(st.tabId, { url });
        return st.tabId;
      }
    }
    const win = await chrome.windows.create({ url, focused: false, type: 'normal', state: 'normal', width: 1280, height: 900 }).catch((e) => (log.warn('could not open the autopilot window', e), null));
    const tabId = win?.tabs?.[0]?.id;
    if (!win || tabId === undefined) return undefined;
    st.windowId = win.id;
    st.tabId = tabId;
    return tabId;
  }

  /** The search page has loaded: start the batch in it. */
  private async go() {
    const ap = this.settings().autopilot;
    const st = await loadState();
    if (!st.running || !st.current || st.tabId === undefined) return;
    const reply = (await chrome.tabs
      .sendMessage(st.tabId, { type: 'command', name: 'apply-queue', via: 'autopilot', opts: { batch: st.current.batch, dryRun: ap.dryRun, unattended: true, autoSubmit: !ap.dryRun, cap: ap.dailyCap, relevant: relevantWords(titlesOf(ap)) } }, { frameId: 0 })
      .catch(() => null)) as { ok?: boolean; list?: boolean } | null;
    if (!reply?.list) {
      if (++st.current.tries < 2) {
        await at(GO, Date.now() + 30_000);
        return save(st, `The LinkedIn list isn't ready yet; trying again in 30 s`);
      }
      // No job list twice: signed out, a checkpoint, or LinkedIn changed. Don't push on.
      return this.stop('LinkedIn showed no job list in the autopilot window (signed out, a security check, or the page changed). Have a look, then start it again.', true);
    }
    st.phase = 'batch';
    await save(st, `Applying: "${st.current.title}"`);
  }

  /** The content script finished a batch. */
  async onBatchDone(result: { sent: number; dry: number; skipped: number; reason: string; pushback?: string }, tabId?: number) {
    const ap = this.settings().autopilot;
    const st = await loadState();
    if (!st.running || !st.current || (tabId !== undefined && tabId !== st.tabId)) return;
    newDay(st);
    const { title, index } = st.current;
    st.day.sent += result.sent;
    st.day.dry += result.dry;
    st.day.skipped += result.skipped;
    st.day.perTitle[title] = (st.day.perTitle[title] ?? 0) + result.sent + result.dry;
    if (result.sent + result.dry === 0 && /done with this list|no job list/i.test(result.reason)) st.day.exhausted = [...st.day.exhausted, title];
    st.lastTitle = index;
    st.current = undefined;
    await chrome.alarms.clear(WATCHDOG);
    const summary = `"${title}": ${result.sent} sent, ${result.dry} would apply, ${result.skipped} skipped. Today ${st.day.sent + st.day.dry}/${ap.dailyCap}`;
    if (result.pushback) {
      await save(st, summary);
      return this.stop(`LinkedIn pushed back: ${result.pushback}. Stopped so your account stays safe.`, true);
    }
    const next = Date.now() + gapMinutes(ap) * 60_000;
    st.phase = 'waiting';
    st.nextAt = next;
    await at(TICK, next);
    await save(st, `${summary}. Next batch at ${fmt(next)}`);
  }

  /** A batch ran far too long (stuck page): stop it there and carry on later. */
  private async watchdog() {
    const st = await loadState();
    if (!st.running || !st.current) return;
    if (st.tabId !== undefined) await chrome.tabs.sendMessage(st.tabId, { type: 'command', name: 'apply-queue-stop' }, { frameId: 0 }).catch(() => {});
    await this.onBatchDone({ sent: 0, dry: 0, skipped: 0, reason: 'timed out after 50 minutes' }, st.tabId);
  }

  async onWindowRemoved(windowId: number) {
    const st = await loadState();
    if (st.running && windowId === st.windowId) {
      st.windowId = undefined;
      st.tabId = undefined;
      await save(st);
      await this.stop('You closed the autopilot window, so it stopped.');
    }
  }
}
