/**
 * Autopilot runner (background). Opens its own Brave window (unfocused, so your work isn't
 * interrupted), and every 20–40 minutes inside active hours runs one small batch on the next
 * platform in turn (LinkedIn → Naukri → Cutshort), for the next job title on that platform.
 *
 *  - LinkedIn: the apply queue runs the whole batch inside the search page.
 *  - Naukri / Cutshort: the runner reads the search list, then opens each job page in the
 *    autopilot window and asks the page to apply (content/sites.ts), pausing between jobs.
 *
 * Event-driven (alarms + messages), because the service worker sleeps between steps; all
 * state is in chrome.storage.local.
 */
import type { Settings } from './settings';
import { AI_BLOCKING, nextPacificMidnight, batchSize, freshDay, gapMinutes, inActiveHours, ist, linkedInSearchUrl, nextStart, normalizeDay, pickTitle, titleKey, titlesOf, type DayState } from './autopilot';
import { createLogger } from './logger';
import { recordInTracker } from './tracker';
import { keepTabAwake, releaseTab } from './tab-awake';
import { relevantWords, titleRelevant, titleSkipped } from './queue';
import { cutshortSearchUrl, jobKey, NAUKRI_REC_URL, naukriSearchUrl, PLATFORM_NAME, PLATFORMS, type Platform, type SiteJob } from './sites';

const log = createLogger('autopilot');
export const AP_KEY = 'fpAutopilot';
const TICK = 'fp-ap-tick';
const GO = 'fp-ap-go';
const WATCHDOG = 'fp-ap-watchdog';
const NEXT = 'fp-ap-next';
const ALL = [TICK, GO, WATCHDOG, NEXT];
/**
 * Every 30 s while the autopilot is on: Brave stops an idle background worker after ~30 s, and
 * that also drops the debugger session that keeps the autopilot tab awake (lib/tab-awake.ts).
 * This wakes the worker and re-attaches. Kept out of ALL: resume() treats ALL as "a step is due".
 */
const AWAKE = 'fp-ap-awake';
const awakeAlarm = () => chrome.alarms.create(AWAKE, { periodInMinutes: 0.5 });

export type Phase = 'stopped' | 'loading' | 'batch' | 'waiting' | 'outside-hours' | 'done-today' | 'ai-wait';

export interface ApState {
  running: boolean;
  phase: Phase;
  windowId?: number;
  tabId?: number;
  day: DayState;
  lastTitle: number;
  lastTitleBy?: Partial<Record<Platform, number>>;
  lastPlatform?: number;
  current?: {
    platform?: Platform;
    title: string;
    index: number;
    batch: number;
    startedAt: number;
    tries: number;
    /** Naukri / Cutshort: reading the list, on a job page, or pausing before the next job. */
    stage?: 'list' | 'job' | 'pause' | 'rec';
    jobs?: SiteJob[];
    i?: number;
    done?: number;
    sent?: number;
    dry?: number;
    skipped?: number;
  };
  nextAt?: number;
  /** The last Naukri Recommended batch, so a confirmation that arrives late still counts. */
  lastRec?: { at: number; jobs: { id: string; title: string; company: string; url: string }[]; counted: string[] };
  message: string;
  progress?: { text: string; at: number };
  history: { t: number; msg: string }[];
}

const blank = (): ApState => ({ running: false, phase: 'stopped', day: freshDay(ist().date), lastTitle: -1, message: 'Not running', history: [] });

export async function loadState(): Promise<ApState> {
  const got = (await chrome.storage.local.get(AP_KEY))[AP_KEY] as ApState | undefined;
  const st = got ? { ...blank(), ...got } : blank();
  st.day = normalizeDay(st.day);
  return st;
}

async function save(st: ApState, msg?: string) {
  if (msg) {
    st.message = msg;
    st.history = [...st.history, { t: Date.now(), msg }].slice(-80);
    log.info(msg);
  }
  await chrome.storage.local.set({ [AP_KEY]: st });
  void chrome.action.setBadgeText({ text: st.running ? (st.phase === 'batch' || st.phase === 'loading' ? 'AP' : 'ap') : '' }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ color: '#16a34a' }).catch(() => {});
}

const at = (name: string, when: number) => chrome.alarms.create(name, { when: Math.max(Date.now() + 1000, when) });
const fmt = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const rand = (a: number, b: number) => a + Math.random() * Math.max(0, b - a);
/** Time to let a page load before acting on it: 30–55 s, never the same twice (alarms can't fire sooner than 30 s). */
const loadWait = () => Math.round(rand(30, 55) * 1000);

function newDay(st: ApState) {
  const today = ist().date;
  if (st.day.date !== today) st.day = freshDay(today);
}

function tomorrowStart(ap: Settings['autopilot']): Date {
  if (!ap.useHours) return nextStart(ap); // just after the next midnight India time
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

/** Per-platform switches and limits. */
export function platformPrefs(ap: Settings['autopilot'], p: Platform) {
  if (p === 'linkedin') return { enabled: ap.linkedinEnabled, dailyCap: ap.dailyCap, dryRun: ap.dryRun, maxExpMin: 99 };
  return ap[p];
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
    const ap = this.settings().autopilot;
    const on = PLATFORMS.filter((p) => platformPrefs(ap, p).enabled).map((p) => `${PLATFORM_NAME[p]}${platformPrefs(ap, p).dryRun ? ' (dry run)' : ''}`);
    await save(st, `Autopilot started: ${on.join(', ') || 'no platform turned on'}`);
    await awakeAlarm();
    await this.tick();
  }

  async stop(reason = 'Stopped by you', alert = false) {
    const st = await loadState();
    if (st.tabId !== undefined) await chrome.tabs.sendMessage(st.tabId, { type: 'command', name: 'apply-queue-stop' }, { frameId: 0 }).catch(() => {});
    await Promise.all([...ALL, AWAKE].map((a) => chrome.alarms.clear(a)));
    await releaseTab(st.tabId);
    try {
      chrome.power?.releaseKeepAwake();
    } catch {
      /* ignore */
    }
    st.running = false;
    st.phase = 'stopped';
    st.current = undefined;
    st.progress = undefined;
    st.nextAt = undefined;
    await save(st, reason);
    if (alert) {
      notify('FormPilot autopilot stopped', reason);
      void chrome.action.setBadgeText({ text: '!' }).catch(() => {});
      void chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }).catch(() => {});
    }
  }

  /** The worker started (Brave restart, update): if the autopilot was on, pick up again. */
  async resume() {
    const st = await loadState();
    if (!st.running) return;
    if (!(await chrome.alarms.get(AWAKE))) await awakeAlarm();
    if (st.tabId !== undefined) await keepTabAwake(st.tabId);
    const alarms = await Promise.all(ALL.map((a) => chrome.alarms.get(a)));
    if (alarms.some(Boolean)) return;
    st.current = undefined;
    await save(st, 'Picking up after Brave or FormPilot restarted');
    await this.tick();
  }

  /** Skip the current break: the pause between jobs, or the break between batches. */
  async runNow() {
    const st = await loadState();
    if (!st.running) return this.start();
    if (st.current) {
      if (st.current.stage === 'pause') {
        await chrome.alarms.clear(NEXT);
        return this.nextJob();
      }
      if (st.tabId !== undefined) await chrome.tabs.sendMessage(st.tabId, { type: 'command', name: 'apply-queue-skip-pause' }, { frameId: 0 }).catch(() => {});
      return;
    }
    await this.tick(true);
  }

  async onAlarm(name: string) {
    if (name === TICK) await this.tick();
    else if (name === GO) await this.go();
    else if (name === NEXT) await this.nextJob();
    else if (name === WATCHDOG) await this.watchdog();
    else if (name === AWAKE) await this.stayAwake();
  }

  private async stayAwake() {
    const st = await loadState();
    if (!st.running) return void chrome.alarms.clear(AWAKE);
    if (st.tabId !== undefined) await keepTabAwake(st.tabId);
  }

  /** The browser dropped the session on the autopilot's tab (worker stopped, tab crashed, …): reconnect. */
  async onDetach(tabId: number | undefined, reason: string) {
    const st = await loadState();
    if (!st.running || tabId === undefined || tabId !== st.tabId) return;
    if (reason === 'canceled_by_user') log.warn('the "debugging this browser" bar was closed; the autopilot reconnects at its next step');
    else if (await keepTabAwake(tabId)) log.debug(`autopilot tab reconnected (${reason})`);
  }

  /** Next platform with something left today, and its next title. */
  private choose(st: ApState, ap: Settings['autopilot']) {
    const titles = titlesOf(ap);
    for (let k = 1; k <= PLATFORMS.length; k++) {
      const pi = ((st.lastPlatform ?? -1) + k) % PLATFORMS.length;
      const p = PLATFORMS[pi];
      const pp = platformPrefs(ap, p);
      if (!pp.enabled) continue;
      const counts = st.day.byPlatform[p];
      if (counts.sent + counts.dry >= pp.dailyCap) continue;
      const view: DayState = { ...st.day, sent: counts.sent, dry: counts.dry };
      // Naukri: the Recommended jobs page first (only Naukri-apply jobs, up to 5 per Apply).
      // The Recommended list refreshes during the day: look again 3 hours after it ran dry.
      if (st.day.exhausted.includes('naukri:rec') && st.day.recEmptyAt && Date.now() - st.day.recEmptyAt > 3 * 3600_000) {
        st.day.exhausted = st.day.exhausted.filter((k) => k !== 'naukri:rec');
      }
      if (p === 'naukri' && ap.naukri.mode === 'recommended' && !st.day.exhausted.includes('naukri:rec')) {
        const size = Math.min(5, batchSize({ ...ap, dailyCap: pp.dailyCap, perTitleCap: 100 }, view, '__rec'));
        if (size > 0) return { platform: p, pi, title: 'Recommended jobs', index: -1, size, dryRun: pp.dryRun, rec: true };
      }
      const keys = titles.map((t) => titleKey(p, t));
      const pick = pickTitle(keys, view, ap.perTitleCap, st.lastTitleBy?.[p] ?? (p === 'linkedin' ? st.lastTitle : -1));
      if (!pick) continue;
      const title = titles[pick.index];
      const size = batchSize({ ...ap, dailyCap: pp.dailyCap }, view, pick.title);
      if (size > 0) return { platform: p, pi, title, index: pick.index, size, dryRun: pp.dryRun, rec: false };
    }
    return null;
  }

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
    const c = this.choose(st, ap);
    if (!c) {
      const next = tomorrowStart(ap).getTime();
      st.phase = 'done-today';
      st.nextAt = next;
      await at(TICK, next);
      return save(st, `Done for today (limits reached or nothing left to search). Back at ${fmt(next)}`);
    }
    try {
      chrome.power?.requestKeepAwake('display');
    } catch {
      /* ignore */
    }
    const custom = ap.searchUrl.includes('{title}') ? ap.searchUrl.replace('{title}', encodeURIComponent(c.title)).replace('{platform}', c.platform) : '';
    // A title whose recent search ran out today is searched over the past week instead.
    const days = (st.day.widened ?? []).includes(titleKey(c.platform, c.title)) ? Math.max(7, ap.postedDays) : ap.postedDays;
    const url = c.rec ? ap.naukri.recUrl || NAUKRI_REC_URL : custom || (c.platform === 'linkedin' ? linkedInSearchUrl(c.title, { ...ap, postedDays: days }) : c.platform === 'naukri' ? naukriSearchUrl(c.title, days) : cutshortSearchUrl(c.title));
    const tabId = await this.ensureTab(st, url);
    if (tabId === undefined) return this.stop("Couldn't open the autopilot window", true);
    await keepTabAwake(tabId);
    st.lastPlatform = c.pi;
    st.current = { platform: c.platform, title: c.title, index: c.index, batch: c.size, startedAt: Date.now(), tries: 0, ...(c.platform === 'linkedin' ? {} : { stage: c.rec ? ('rec' as const) : ('list' as const), i: 0, done: 0, sent: 0, dry: 0, skipped: 0 }) };
    st.phase = 'loading';
    st.nextAt = undefined;
    st.progress = { text: `Opening the ${PLATFORM_NAME[c.platform]} search`, at: Date.now() };
    await at(GO, Date.now() + loadWait());
    // A batch that stops moving is closed early: LinkedIn runs a whole batch in one page (35 min),
    // Naukri / Cutshort re-arm this for every job (see openJob).
    await at(WATCHDOG, Date.now() + (c.platform === 'linkedin' ? 35 : 15) * 60_000);
    await save(st, `${PLATFORM_NAME[c.platform]}: searching "${c.title}"${!c.rec && days !== ap.postedDays ? ` (past ${days} days)` : ''} (batch of ${c.size}${c.dryRun ? ', dry run' : ''})`);
  }

  private async ensureTab(st: ApState, url: string): Promise<number | undefined> {
    if (st.tabId !== undefined) {
      const tab = await chrome.tabs.get(st.tabId).catch(() => null);
      if (tab && tab.windowId === st.windowId) {
        await chrome.tabs.update(st.tabId, { url, active: true });
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

  /**
   * The autopilot's tab must keep running at full speed: in a hidden tab LinkedIn's Easy Apply
   * doesn't open and every wait crawls. Two causes, two fixes:
   *  - another tab in front of it in its window (17 Nov: stalled every LinkedIn batch): select it
   *    again inside its own window, without focusing the window or taking you away from your work;
   *  - its window behind other windows, which Brave also treats as hidden: lib/tab-awake.ts.
   */
  private async front(tabId: number) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      log.info('brought the autopilot tab back to the front of its window');
    }
    await keepTabAwake(tabId);
  }

  private relevant(ap: Settings['autopilot']) {
    return ap.mustWords.trim() ? relevantWords(ap.mustWords.split(/[,\n]+/)) : relevantWords(titlesOf(ap));
  }

  /** The page has loaded: start the batch (LinkedIn), read the list, or apply on the job page. */
  private async go() {
    const ap = this.settings().autopilot;
    const st = await loadState();
    const cur = st.current;
    if (!st.running || !cur || st.tabId === undefined) return;
    await this.front(st.tabId);
    const p = cur.platform ?? 'linkedin';
    const pp = platformPrefs(ap, p);
    if (p === 'linkedin') {
      const reply = (await chrome.tabs
        .sendMessage(
          st.tabId,
          {
            type: 'command',
            name: 'apply-queue',
            via: 'autopilot',
            opts: {
              batch: cur.batch,
              dryRun: pp.dryRun,
              unattended: true,
              autoSubmit: !pp.dryRun,
              cap: pp.dailyCap,
              relevant: this.relevant(ap),
              skipTitles: ap.skipWords,
              pauseSec: [ap.pauseMinSec, Math.max(ap.pauseMinSec, ap.pauseMaxSec)],
            },
          },
          { frameId: 0 },
        )
        .catch(() => null)) as { ok?: boolean; list?: boolean } | null;
      if (!reply?.list) return this.notReady(st, 'LinkedIn showed no job list in the autopilot window (signed out, a security check, or the page changed)');
      st.phase = 'batch';
      return save(st, `LinkedIn: applying for "${cur.title}"`);
    }
    if (cur.stage === 'rec') {
      const ok = await chrome.tabs
        .sendMessage(st.tabId, { type: 'command', name: 'naukri-rec', opts: { max: cur.batch, dryRun: pp.dryRun, relevant: this.relevant(ap), skipTitles: ap.skipWords, maxExpMin: pp.maxExpMin, seen: st.day.seen } }, { frameId: 0 })
        .catch(() => null);
      if (!ok) return this.notReady(st, "Naukri's Recommended jobs page didn't load", () => this.finishBatch(st, 'recommended page not ready', true, 'naukri:rec'));
      st.phase = 'batch';
      st.progress = { text: `${pp.dryRun ? 'Dry run · ' : ''}Naukri · choosing up to ${cur.batch} recommended jobs`, at: Date.now() };
      return save(st, `Naukri: picking up to ${cur.batch} from Recommended jobs`);
    }
    if (cur.stage === 'list') {
      const reply = (await chrome.tabs.sendMessage(st.tabId, { type: 'command', name: 'site-list', platform: p }, { frameId: 0 }).catch(() => null)) as { jobs?: SiteJob[]; pushback?: string } | null;
      if (reply?.pushback) return this.stop(`${reply.pushback}. Stopped so your account stays safe.`, true);
      if (!reply?.jobs?.length) return this.notReady(st, `${PLATFORM_NAME[p]} showed no job list (signed out, no results, or the page changed)`, () => this.finishBatch(st, 'no job list', true));
      const rel = this.relevant(ap);
      const seen = new Set(st.day.seen);
      const keys = new Set<string>();
      // Naukri lists some jobs twice under different links: one try per company + title.
      const fresh = reply.jobs.filter((j) => {
        const k = jobKey(j);
        const ok = !j.applied && !seen.has(j.url) && !seen.has(k) && !keys.has(k) && titleRelevant(j.title, rel) && !titleSkipped(j.title, ap.skipWords) && (j.expMin === undefined || j.expMin <= pp.maxExpMin);
        if (ok) keys.add(k);
        return ok;
      });
      log.info(
        `${PLATFORM_NAME[p]} list for "${cur.title}": ${reply.jobs.length} jobs, ${fresh.length} to try`,
        reply.jobs.map((j) => `${fresh.includes(j) ? '+' : '-'} ${j.title} · ${j.company}${j.expMin !== undefined ? ` · ${j.expMin}+ yrs` : ''}${j.applied ? ' · applied' : ''}`),
      );
      if (!fresh.length) return this.finishBatch(st, 'nothing new in this search', true);
      // Some will be skipped (company-site apply, already applied): keep spares so the batch still fills up.
      cur.jobs = fresh.slice(0, cur.batch * 3);
      cur.i = 0;
      st.phase = 'batch';
      await save(st, `${PLATFORM_NAME[p]}: ${Math.min(cur.batch, cur.jobs.length)} to apply for "${cur.title}" (${cur.jobs.length} candidates)`);
      return this.openJob(st);
    }
    if (cur.stage === 'job') {
      const job = cur.jobs?.[cur.i ?? 0];
      if (!job) return this.finishBatch(st, 'batch done');
      const ok = await chrome.tabs.sendMessage(st.tabId, { type: 'command', name: 'site-apply', platform: p, opts: { dryRun: pp.dryRun } }, { frameId: 0 }).catch(() => null);
      if (!ok) {
        if (++cur.tries < 2) {
          await at(GO, Date.now() + loadWait());
          return save(st);
        }
        await save(st);
        return this.onJobDone({ outcome: 'skip', reason: "the job page didn't load" }, st.tabId);
      }
      st.progress = { text: `${pp.dryRun ? 'Dry run · ' : ''}${PLATFORM_NAME[p]} · ${job.title} · ${job.company} (${(cur.i ?? 0) + 1} of ${cur.jobs?.length})`, at: Date.now() };
      await save(st);
    }
  }

  /** The page wasn't ready: try once more in 30 s, then `fallback` (or stop). */
  private async notReady(st: ApState, why: string, fallback?: () => Promise<void>) {
    if (st.current && ++st.current.tries < 2) {
      await at(GO, Date.now() + loadWait());
      return save(st, `${why}; trying again in 30 s`);
    }
    if (fallback) return fallback();
    return this.stop(`${why}. Have a look, then start it again.`, true);
  }

  private async openJob(st: ApState) {
    const cur = st.current!;
    const job = cur.jobs![cur.i ?? 0];
    cur.stage = 'job';
    cur.tries = 0;
    st.day.seen = [...st.day.seen, job.url, jobKey(job)].slice(-1500);
    st.progress = { text: `Opening ${job.title} · ${job.company}`, at: Date.now() };
    if (st.tabId !== undefined) await chrome.tabs.update(st.tabId, { url: job.url, active: true }).catch(() => {});
    await at(GO, Date.now() + loadWait());
    await at(WATCHDOG, Date.now() + 12 * 60_000);
    await save(st);
  }

  /** A Naukri / Cutshort job page finished. */
  async onJobDone(result: { outcome: 'sent' | 'dry' | 'skip'; reason: string; pushback?: string; aiError?: string }, tabId?: number) {
    const ap = this.settings().autopilot;
    const st = await loadState();
    const cur = st.current;
    if (!st.running || !cur?.jobs || (tabId !== undefined && tabId !== st.tabId)) return;
    newDay(st);
    const p = cur.platform as Platform;
    const job = cur.jobs[cur.i ?? 0];
    const counts = st.day.byPlatform[p];
    if (result.aiError && AI_BLOCKING.has(result.aiError)) {
      // Not this job's fault: forget we tried it, so a later batch picks it up again.
      if (job) st.day.seen = st.day.seen.filter((u) => u !== job.url);
      return this.aiPause(st, result.aiError);
    }
    if (result.outcome === 'sent') {
      counts.sent++;
      st.day.sent++;
      cur.sent = (cur.sent ?? 0) + 1;
    } else if (result.outcome === 'dry') {
      counts.dry++;
      st.day.dry++;
      cur.dry = (cur.dry ?? 0) + 1;
    } else {
      counts.skipped++;
      st.day.skipped++;
      cur.skipped = (cur.skipped ?? 0) + 1;
    }
    if (result.outcome !== 'skip') {
      const k = titleKey(p, cur.title);
      st.day.perTitle[k] = (st.day.perTitle[k] ?? 0) + 1;
      cur.done = (cur.done ?? 0) + 1;
    }
    const verb = result.outcome === 'sent' ? 'Applied' : result.outcome === 'dry' ? 'Would apply' : 'Skipped';
    await save(st, `${PLATFORM_NAME[p]} · ${verb}: ${job?.title ?? '?'} · ${job?.company ?? ''} (${result.reason})`);
    if (result.pushback) return this.stop(`${result.pushback}. Stopped so your account stays safe.`, true);
    cur.i = (cur.i ?? 0) + 1;
    if (cur.i >= (cur.jobs?.length ?? 0) || (cur.done ?? 0) >= cur.batch || counts.sent + counts.dry >= platformPrefs(ap, p).dailyCap) return this.finishBatch(st, 'batch done');
    // A person-like pause before the next job (alarms can't fire sooner than 30 s).
    const secs = Math.max(30, rand(ap.pauseMinSec, Math.max(ap.pauseMinSec, ap.pauseMaxSec)));
    cur.stage = 'pause';
    st.progress = { text: `Pause before the next job · ${Math.round(secs)} s (${cur.i} of ${cur.jobs.length} in this batch)`, at: Date.now() };
    await at(NEXT, Date.now() + secs * 1000);
    await save(st);
  }

  /**
   * The AI couldn't answer. A per-minute limit or a hiccup: wait 3–7 min. A used-up daily
   * quota: wait for the reset (Gemini: midnight Pacific = 13:30 India time), tell you. A bad
   * key or no provider: stop and tell you. The job it was on is not counted and is tried again.
   */
  private async aiPause(st: ApState, code: string) {
    await Promise.all([GO, NEXT, WATCHDOG].map((a) => chrome.alarms.clear(a)));
    if (code === 'auth' || code === 'no-provider' || code === 'locked') {
      await save(st);
      return this.stop(`The AI can't be used (${code === 'auth' ? 'the API key was refused' : code === 'locked' ? 'your memory vault is locked' : 'no AI provider is set up'}). Fix it in FormPilot settings → AI Providers, then start again.`, true);
    }
    st.current = undefined;
    st.progress = undefined;
    const next = code === 'quota' ? nextPacificMidnight().getTime() + rand(4, 15) * 60_000 : Date.now() + rand(3, 7) * 60_000;
    st.phase = 'ai-wait';
    st.nextAt = next;
    await at(TICK, next);
    const msg =
      code === 'quota'
        ? `Gemini's free daily quota is used up. Waiting for it to reset; next batch at ${fmt(next)}. (Add a second AI provider in settings to keep going.)`
        : `The AI is busy (${code}). Waiting a few minutes; next batch at ${fmt(next)}`;
    await save(st, msg);
    if (code === 'quota') notify('FormPilot autopilot is waiting for the AI', msg);
  }

  private async nextJob() {
    const st = await loadState();
    if (!st.running || !st.current?.jobs) return;
    await this.openJob(st);
  }

  /**
   * A search ran out. The first time today (searching only recent jobs), widen that title to the
   * past week; after that, it's done for today. Naukri's Recommended list is looked at again later.
   */
  private exhaust(st: ApState, key: string) {
    const ap = this.settings().autopilot;
    if (key === 'naukri:rec') {
      st.day.recEmptyAt = Date.now();
      if (!st.day.exhausted.includes(key)) st.day.exhausted = [...st.day.exhausted, key];
      return;
    }
    const widened = st.day.widened ?? [];
    if (ap.postedDays < 7 && !widened.includes(key)) {
      st.day.widened = [...widened, key];
      log.info(`"${key}": nothing left in the last ${ap.postedDays} day(s); searching the past week next time`);
      return;
    }
    if (!st.day.exhausted.includes(key)) st.day.exhausted = [...st.day.exhausted, key];
  }

  private async finishBatch(st: ApState, why: string, exhausted = false, exhaustedKey?: string) {
    const ap = this.settings().autopilot;
    const cur = st.current!;
    const p = (cur.platform ?? 'linkedin') as Platform;
    if (exhausted) this.exhaust(st, exhaustedKey ?? titleKey(p, cur.title));
    if (cur.index >= 0) st.lastTitleBy = { ...(st.lastTitleBy ?? {}), [p]: cur.index };
    st.current = undefined;
    st.progress = undefined;
    await Promise.all([GO, NEXT, WATCHDOG].map((a) => chrome.alarms.clear(a)));
    const next = Date.now() + gapMinutes(ap) * 60_000;
    st.phase = 'waiting';
    st.nextAt = next;
    await at(TICK, next);
    const b = st.day.byPlatform[p];
    await save(st, `${PLATFORM_NAME[p]} "${cur.title}": ${cur.sent ?? 0} sent, ${cur.dry ?? 0} would apply, ${cur.skipped ?? 0} skipped (${why}). ${PLATFORM_NAME[p]} today ${b.sent + b.dry}/${platformPrefs(ap, p).dailyCap}. Next batch at ${fmt(next)}`);
  }

  /** Which recommended jobs were ticked, just before Apply (the result may come from another page). */
  async onRecPicked(picked: { id: string; title: string; company: string; url: string }[], tabId?: number) {
    const st = await loadState();
    if (!st.running || st.current?.stage !== 'rec' || (tabId !== undefined && tabId !== st.tabId)) return;
    st.current.jobs = picked.map((j) => ({ ...j, id: j.id }) as SiteJob & { id: string });
    st.progress = { text: `Naukri · applying to ${picked.length}: ${picked.map((j) => j.title).join(', ')}`, at: Date.now() };
    await save(st);
  }

  /** The Recommended jobs batch on Naukri finished (ticked + Apply + chatbot, or a dry run). */
  async onRecDone(result: { picked: { id: string; title: string; company: string; url: string }[]; outcome: 'sent' | 'dry' | 'skip' | 'none'; reason: string; status?: Record<string, number>; pushback?: string; aiError?: string }, tabId?: number) {
    const st = await loadState();
    const cur = st.current;
    if (tabId !== undefined && tabId !== st.tabId) return;
    // Naukri's confirmation page loaded after the batch was already closed (its first report
    // said "skipped"): count the jobs Naukri says went through.
    if (cur?.stage !== 'rec') {
      const last = st.lastRec;
      if (!st.running || !last || Date.now() - last.at > 10 * 60_000 || !result.status) return;
      newDay(st);
      for (const j of last.jobs) {
        if (result.status[j.id] !== 200 || last.counted.includes(j.id)) continue;
        last.counted.push(j.id);
        const c = st.day.byPlatform.naukri;
        c.sent++;
        st.day.sent++;
        if (c.skipped > 0) (c.skipped--, st.day.skipped--);
        st.history = [...st.history, { t: Date.now(), msg: `Naukri · Applied: ${j.title} · ${j.company} (confirmed by Naukri)` }].slice(-80);
        // The page that would have recorded it is gone: record it in the job tracker here.
        const s = this.settings();
        if (s.tracker.enabled) await recordInTracker(s, 'applied', { url: j.url, role: j.title, company: j.company, location: '', source: 'Naukri', salary: '', description: '' }, [], 'Autopilot naukri').catch(() => {});
      }
      return save(st);
    }
    newDay(st);
    if (result.pushback) {
      await save(st, `Naukri: ${result.reason}`);
      return this.stop(`${result.pushback}. Stopped so your account stays safe.`, true);
    }
    if (result.aiError && AI_BLOCKING.has(result.aiError)) return this.aiPause(st, result.aiError);
    if (result.outcome === 'none') return this.finishBatch(st, 'no recommended job fits; job searches next', true, 'naukri:rec');
    const counts = st.day.byPlatform.naukri;
    // From the confirmation page the list is empty: use what was ticked.
    const picked = result.picked.length ? result.picked : ((cur.jobs ?? []) as unknown as { id: string; title: string; company: string; url: string }[]);
    st.lastRec = { at: Date.now(), jobs: picked, counted: [] };
    for (const j of picked) {
      st.day.seen = [...st.day.seen, `naukri:${j.id}`, jobKey(j)].slice(-1500);
      const outcome = result.outcome === 'dry' ? 'dry' : result.status ? (result.status[j.id] === 200 ? 'sent' : 'skip') : result.outcome === 'sent' ? 'sent' : 'skip';
      if (outcome === 'sent') {
        counts.sent++;
        st.day.sent++;
        cur.sent = (cur.sent ?? 0) + 1;
        st.lastRec.counted.push(j.id);
      } else if (outcome === 'dry') {
        counts.dry++;
        st.day.dry++;
        cur.dry = (cur.dry ?? 0) + 1;
      } else {
        counts.skipped++;
        st.day.skipped++;
        cur.skipped = (cur.skipped ?? 0) + 1;
      }
      const verb = outcome === 'sent' ? 'Applied' : outcome === 'dry' ? 'Would apply' : 'Not applied';
      st.history = [...st.history, { t: Date.now(), msg: `Naukri · ${verb}: ${j.title} · ${j.company}${outcome === 'skip' ? ` (${result.status ? `Naukri status ${result.status[j.id] ?? '?'}` : result.reason})` : ''}` }].slice(-80);
    }
    return this.finishBatch(st, result.reason);
  }

  /** LinkedIn's queue finished a batch. */
  async onBatchDone(result: { sent: number; dry: number; skipped: number; reason: string; pushback?: string; aiError?: string }, tabId?: number) {
    const ap = this.settings().autopilot;
    const st = await loadState();
    if (!st.running || !st.current || (tabId !== undefined && tabId !== st.tabId)) return;
    newDay(st);
    const { title, index } = st.current;
    const li = st.day.byPlatform.linkedin;
    li.sent += result.sent;
    li.dry += result.dry;
    li.skipped += result.skipped;
    st.day.sent += result.sent;
    st.day.dry += result.dry;
    st.day.skipped += result.skipped;
    st.day.perTitle[title] = (st.day.perTitle[title] ?? 0) + result.sent + result.dry;
    if (result.sent + result.dry === 0 && /done with this list|no job list/i.test(result.reason)) this.exhaust(st, title);
    st.lastTitle = index;
    st.lastTitleBy = { ...(st.lastTitleBy ?? {}), linkedin: index };
    st.current = undefined;
    st.progress = undefined;
    await chrome.alarms.clear(WATCHDOG);
    const summary = `LinkedIn "${title}": ${result.sent} sent, ${result.dry} would apply, ${result.skipped} skipped. LinkedIn today ${li.sent + li.dry}/${ap.dailyCap}`;
    if (result.pushback) {
      await save(st, summary);
      return this.stop(`LinkedIn pushed back: ${result.pushback}. Stopped so your account stays safe.`, true);
    }
    if (result.aiError && AI_BLOCKING.has(result.aiError)) {
      await save(st, summary);
      return this.aiPause(st, result.aiError);
    }
    const next = Date.now() + gapMinutes(ap) * 60_000;
    st.phase = 'waiting';
    st.nextAt = next;
    await at(TICK, next);
    await save(st, `${summary}. Next batch at ${fmt(next)}`);
  }

  /** LinkedIn skipped a job inside its batch: say which and why in the history (Naukri does per job already). */
  async onSkip(job: string, reason: string, tabId?: number) {
    const st = await loadState();
    if (!st.running || !st.current || (tabId !== undefined && tabId !== st.tabId)) return;
    await save(st, `${st.current.platform ? PLATFORM_NAME[st.current.platform] : "LinkedIn"} · Skipped: ${job} (${reason || 'no reason given'})`);
  }

  async onProgress(text: string, tabId?: number) {
    const st = await loadState();
    if (!st.running || !st.current || (tabId !== undefined && tabId !== st.tabId)) return;
    st.progress = { text, at: Date.now() };
    await chrome.storage.local.set({ [AP_KEY]: st });
    if (st.tabId !== undefined) await this.front(st.tabId);
  }

  /** A batch ran far too long (stuck page): stop it there and carry on later. */
  private async watchdog() {
    const st = await loadState();
    if (!st.running || !st.current) return;
    if (st.tabId !== undefined) await chrome.tabs.sendMessage(st.tabId, { type: 'command', name: 'apply-queue-stop' }, { frameId: 0 }).catch(() => {});
    if (st.current.platform && st.current.platform !== 'linkedin') return this.finishBatch(st, 'stopped moving (page left or stuck); moved on');
    await this.onBatchDone({ sent: 0, dry: 0, skipped: 0, reason: 'stopped moving (page left or stuck); moved on' }, st.tabId);
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
