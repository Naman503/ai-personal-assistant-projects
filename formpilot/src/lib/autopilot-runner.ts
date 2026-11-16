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
import { batchSize, freshDay, gapMinutes, inActiveHours, ist, linkedInSearchUrl, nextStart, normalizeDay, pickTitle, titleKey, titlesOf, type DayState } from './autopilot';
import { createLogger } from './logger';
import { relevantWords, titleRelevant, titleSkipped } from './queue';
import { cutshortSearchUrl, naukriSearchUrl, PLATFORM_NAME, PLATFORMS, type Platform, type SiteJob } from './sites';

const log = createLogger('autopilot');
export const AP_KEY = 'fpAutopilot';
const TICK = 'fp-ap-tick';
const GO = 'fp-ap-go';
const WATCHDOG = 'fp-ap-watchdog';
const NEXT = 'fp-ap-next';
const ALL = [TICK, GO, WATCHDOG, NEXT];

export type Phase = 'stopped' | 'loading' | 'batch' | 'waiting' | 'outside-hours' | 'done-today';

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
    stage?: 'list' | 'job' | 'pause';
    jobs?: SiteJob[];
    i?: number;
    done?: number;
    sent?: number;
    dry?: number;
    skipped?: number;
  };
  nextAt?: number;
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

function newDay(st: ApState) {
  const today = ist().date;
  if (st.day.date !== today) st.day = freshDay(today);
}

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
    await this.tick();
  }

  async stop(reason = 'Stopped by you', alert = false) {
    const st = await loadState();
    if (st.tabId !== undefined) await chrome.tabs.sendMessage(st.tabId, { type: 'command', name: 'apply-queue-stop' }, { frameId: 0 }).catch(() => {});
    await Promise.all(ALL.map((a) => chrome.alarms.clear(a)));
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
      const keys = titles.map((t) => titleKey(p, t));
      const pick = pickTitle(keys, view, ap.perTitleCap, st.lastTitleBy?.[p] ?? (p === 'linkedin' ? st.lastTitle : -1));
      if (!pick) continue;
      const title = titles[pick.index];
      const size = batchSize({ ...ap, dailyCap: pp.dailyCap }, view, pick.title);
      if (size > 0) return { platform: p, pi, title, index: pick.index, size, dryRun: pp.dryRun };
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
    const url = custom || (c.platform === 'linkedin' ? linkedInSearchUrl(c.title, ap) : c.platform === 'naukri' ? naukriSearchUrl(c.title, ap.postedDays) : cutshortSearchUrl(c.title));
    const tabId = await this.ensureTab(st, url);
    if (tabId === undefined) return this.stop("Couldn't open the autopilot window", true);
    st.lastPlatform = c.pi;
    st.current = { platform: c.platform, title: c.title, index: c.index, batch: c.size, startedAt: Date.now(), tries: 0, ...(c.platform === 'linkedin' ? {} : { stage: 'list' as const, i: 0, done: 0, sent: 0, dry: 0, skipped: 0 }) };
    st.phase = 'loading';
    st.nextAt = undefined;
    st.progress = { text: `Opening the ${PLATFORM_NAME[c.platform]} search`, at: Date.now() };
    await at(GO, Date.now() + 30_000);
    await at(WATCHDOG, Date.now() + 60 * 60_000);
    await save(st, `${PLATFORM_NAME[c.platform]}: searching "${c.title}" (batch of ${c.size}${c.dryRun ? ', dry run' : ''})`);
  }

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

  private relevant(ap: Settings['autopilot']) {
    return ap.mustWords.trim() ? relevantWords(ap.mustWords.split(/[,\n]+/)) : relevantWords(titlesOf(ap));
  }

  /** The page has loaded: start the batch (LinkedIn), read the list, or apply on the job page. */
  private async go() {
    const ap = this.settings().autopilot;
    const st = await loadState();
    const cur = st.current;
    if (!st.running || !cur || st.tabId === undefined) return;
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
    if (cur.stage === 'list') {
      const reply = (await chrome.tabs.sendMessage(st.tabId, { type: 'command', name: 'site-list', platform: p }, { frameId: 0 }).catch(() => null)) as { jobs?: SiteJob[]; pushback?: string } | null;
      if (reply?.pushback) return this.stop(`${reply.pushback}. Stopped so your account stays safe.`, true);
      if (!reply?.jobs?.length) return this.notReady(st, `${PLATFORM_NAME[p]} showed no job list (signed out, no results, or the page changed)`, () => this.finishBatch(st, 'no job list', true));
      const rel = this.relevant(ap);
      const seen = new Set(st.day.seen);
      const fresh = reply.jobs.filter((j) => !j.applied && !seen.has(j.url) && titleRelevant(j.title, rel) && !titleSkipped(j.title, ap.skipWords) && (j.expMin === undefined || j.expMin <= pp.maxExpMin));
      log.info(
        `${PLATFORM_NAME[p]} list for "${cur.title}": ${reply.jobs.length} jobs, ${fresh.length} to try`,
        reply.jobs.map((j) => `${fresh.includes(j) ? '+' : '-'} ${j.title} · ${j.company}${j.expMin !== undefined ? ` · ${j.expMin}+ yrs` : ''}${j.applied ? ' · applied' : ''}`),
      );
      if (!fresh.length) return this.finishBatch(st, 'nothing new in this search', true);
      cur.jobs = fresh.slice(0, cur.batch);
      cur.i = 0;
      st.phase = 'batch';
      await save(st, `${PLATFORM_NAME[p]}: ${cur.jobs.length} job(s) to try for "${cur.title}"`);
      return this.openJob(st);
    }
    if (cur.stage === 'job') {
      const job = cur.jobs?.[cur.i ?? 0];
      if (!job) return this.finishBatch(st, 'batch done');
      const ok = await chrome.tabs.sendMessage(st.tabId, { type: 'command', name: 'site-apply', platform: p, opts: { dryRun: pp.dryRun } }, { frameId: 0 }).catch(() => null);
      if (!ok) {
        if (++cur.tries < 2) {
          await at(GO, Date.now() + 30_000);
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
      await at(GO, Date.now() + 30_000);
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
    st.day.seen = [...st.day.seen, job.url].slice(-800);
    st.progress = { text: `Opening ${job.title} · ${job.company}`, at: Date.now() };
    if (st.tabId !== undefined) await chrome.tabs.update(st.tabId, { url: job.url }).catch(() => {});
    await at(GO, Date.now() + 30_000);
    await save(st);
  }

  /** A Naukri / Cutshort job page finished. */
  async onJobDone(result: { outcome: 'sent' | 'dry' | 'skip'; reason: string; pushback?: string }, tabId?: number) {
    const ap = this.settings().autopilot;
    const st = await loadState();
    const cur = st.current;
    if (!st.running || !cur?.jobs || (tabId !== undefined && tabId !== st.tabId)) return;
    newDay(st);
    const p = cur.platform as Platform;
    const job = cur.jobs[cur.i ?? 0];
    const counts = st.day.byPlatform[p];
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

  private async nextJob() {
    const st = await loadState();
    if (!st.running || !st.current?.jobs) return;
    await this.openJob(st);
  }

  private async finishBatch(st: ApState, why: string, exhausted = false) {
    const ap = this.settings().autopilot;
    const cur = st.current!;
    const p = (cur.platform ?? 'linkedin') as Platform;
    if (exhausted) st.day.exhausted = [...st.day.exhausted, titleKey(p, cur.title)];
    st.lastTitleBy = { ...(st.lastTitleBy ?? {}), [p]: cur.index };
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

  /** LinkedIn's queue finished a batch. */
  async onBatchDone(result: { sent: number; dry: number; skipped: number; reason: string; pushback?: string }, tabId?: number) {
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
    if (result.sent + result.dry === 0 && /done with this list|no job list/i.test(result.reason)) st.day.exhausted = [...st.day.exhausted, title];
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
    const next = Date.now() + gapMinutes(ap) * 60_000;
    st.phase = 'waiting';
    st.nextAt = next;
    await at(TICK, next);
    await save(st, `${summary}. Next batch at ${fmt(next)}`);
  }

  async onProgress(text: string, tabId?: number) {
    const st = await loadState();
    if (!st.running || !st.current || (tabId !== undefined && tabId !== st.tabId)) return;
    st.progress = { text, at: Date.now() };
    await chrome.storage.local.set({ [AP_KEY]: st });
  }

  /** A batch ran far too long (stuck page): stop it there and carry on later. */
  private async watchdog() {
    const st = await loadState();
    if (!st.running || !st.current) return;
    if (st.tabId !== undefined) await chrome.tabs.sendMessage(st.tabId, { type: 'command', name: 'apply-queue-stop' }, { frameId: 0 }).catch(() => {});
    if (st.current.platform && st.current.platform !== 'linkedin') return this.finishBatch(st, 'timed out after an hour');
    await this.onBatchDone({ sent: 0, dry: 0, skipped: 0, reason: 'timed out after an hour' }, st.tabId);
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
