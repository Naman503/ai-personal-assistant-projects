/**
 * Site Pilot runner (background). Separate from the Autopilot: its own Brave window, state
 * (chrome.storage.local "fpSitePilot"), alarms ("fp-sp-*"), records (IndexedDB) and AI (the local
 * model only). Both can run at the same time.
 *
 * One job at a time:
 *   pick from the queue → open in Site Pilot's tab → (Naukri: press "Apply on company site" and
 *   follow the link) → rounds in the page (content/sitepilot.ts) until it's sent, ready (dry run),
 *   or left for you → record → pause 1–4 min → next.
 * A round is one stretch of work on one page load. When the page navigates (a multi-page form,
 * Submit) the content script is gone; the runner starts the next round once the new page loads.
 */
import type { Settings, ProviderConfig } from '../settings';
import { createLogger } from '../logger';
import { recordInTracker } from '../tracker';
import { titlesOf } from '../autopilot';
import { relevantWords, titleRelevant, titleSkipped } from '../queue';
import { naukriSearchUrl, type SiteJob } from '../sites';
import { generateWithFallback } from '../llm/registry';
import { userActive, localRun } from '../llm/local-run';
import { pilotProviders } from '../llm/pilot-ai';
import { recordAiCall } from '../ai-stats';
import { keepTabAwake, releaseTab } from '../tab-awake';
import { addShot, addStep, companyCount, companyWall, counts, enqueue, nextQueued, spDb, type NewJob, type SpJob } from './db';
import { ACTION_SCHEMA, agentSystem, buildAgentPrompt, describeAction, parseAction } from './agent';
import { ATS_NAME, detectAts, needsAccount, type Ats } from './detect';
import { boardFromUrl, fetchBoard, fitting, parseBoards, type Board } from './boards';
import { fetchFeeds } from './feeds';
import type { AgentAction, PageSnapshot, RoundContext, RoundResult, SpOutcome } from './types';


/**
 * Pages that only lead to the real application: Naukri's job page / its company hop, and the
 * remote job boards (Himalayas, Remote OK, Remotive, We Work Remotely), whose Apply sends you to
 * the company's own form. While resolving, an address on these isn't the company link yet.
 */
const HOP_HOSTS = /(^|\.)(naukri\.com|himalayas\.app|remoteok\.com|remotive\.com|weworkremotely\.com)$/i;
export const onHop = (u: string) => {
  try {
    return HOP_HOSTS.test(new URL(u).hostname);
  } catch {
    return false;
  }
};
/** A remote-board job page: Site Pilot first follows its Apply link to the company. */
export const BOARD_JOB = /himalayas\.app\/companies\/[^/]+\/jobs\/|remoteok\.com\/remote-jobs\/|remotive\.com\/remote-jobs\/|weworkremotely\.com\/remote-jobs\//i;

const log = createLogger('sitepilot');
export const SP_KEY = 'fpSitePilot';
const TICK = 'fp-sp-tick';
const WATCH = 'fp-sp-watch';
const LOAD = 'fp-sp-load';

export type SpPhase = 'stopped' | 'idle' | 'working' | 'pause' | 'waiting' | 'paused';

export interface SpState {
  running: boolean;
  phase: SpPhase;
  windowId?: number;
  tabId?: number;
  cur?: {
    jobId: string;
    stage: 'resolve' | 'apply' | 'harvest';
    startedAt: number;
    lastActivity: number;
    round: number;
    actions: number;
    submitted: number;
    busy: boolean;
    restarts: number;
    url?: string;
  };
  nextAt?: number;
  message: string;
  /** Why the local model is waiting right now (pacing, you're active). */
  waiting?: string;
  history: { t: number; msg: string }[];
  harvest?: { i: number; at: number };
  /** Paused by you: nothing runs until you press Resume. */
  paused?: boolean;
  /** The job that was in progress when you paused: it goes first after Resume. */
  resumeJob?: string;
  /** A submitted application waiting for you to enter an emailed code in its page. */
  held?: { jobId: string; tabId?: number };
  /** Last read of the company job boards. */
  boardsAt?: number;
}

const LEARNED = 'fpSpBoards';
/** Boards learned from links Site Pilot met (a Naukri job that led to jobs.lever.co/acme…). */
export async function learnedBoards(): Promise<string[]> {
  return ((await chrome.storage.local.get(LEARNED))[LEARNED] as string[] | undefined) ?? [];
}
async function learnBoard(url: string | undefined) {
  const b = url ? boardFromUrl(url) : null;
  if (!b) return;
  const key = `${b.kind}:${b.token}`;
  const have = await learnedBoards();
  if (!have.some((x) => x.toLowerCase() === key.toLowerCase())) await chrome.storage.local.set({ [LEARNED]: [...have, key].slice(-300) });
}

const blank = (): SpState => ({ running: false, phase: 'stopped', message: 'Not running', history: [] });

export async function loadSpState(): Promise<SpState> {
  const got = (await chrome.storage.local.get(SP_KEY))[SP_KEY] as SpState | undefined;
  return got ? { ...blank(), ...got } : blank();
}

async function save(st: SpState, msg?: string) {
  if (msg) {
    st.message = msg;
    st.history = [...st.history, { t: Date.now(), msg }].slice(-120);
    log.info(msg);
  }
  await chrome.storage.local.set({ [SP_KEY]: st });
}

const at = (name: string, when: number) => chrome.alarms.create(name, { when: Math.max(Date.now() + 1000, when) });
const rand = (a: number, b: number) => a + Math.random() * Math.max(0, b - a);
const fmt = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/** The local model as a provider, for Site Pilot's own calls (never the cloud chain). */
export function siteProvider(sp: Settings['sitePilot']): ProviderConfig {
  return {
    id: 'sitepilot-local',
    kind: sp.kind,
    label: `Site Pilot (${sp.model})`,
    enabled: true,
    apiKey: '',
    hasKey: false,
    baseUrl: sp.baseUrl,
    model: sp.model,
    jsonMode: true,
    headers: {},
    altModels: '',
    rpm: 0,
  };
}

/** Settings with the local model as the only provider: what Site Pilot's answers go through. */
export function siteSettings(s: Settings): Settings {
  return {
    ...s,
    providers: pilotProviders(s, 'sitePilot'),
    privacy: { ...s.privacy, localOnly: false },
    generation: {
      ...s.generation,
      fallback: true, // cloud-then-local falls back to the local model
      streaming: false,
      maxRetries: 1,
      thinking: 'off',
      timeoutMs: Math.max(s.generation.timeoutMs, 240_000),
      claims: s.sitePilot.answerStyle,
      // The brief comes first, every time: who the candidate is and how to answer for them.
      customInstructions: [s.sitePilot.brief.trim() && `CANDIDATE BRIEF:\n${s.sitePilot.brief.trim()}`, s.generation.customInstructions.trim()].filter(Boolean).join('\n\n'),
    },
  };
}

/** Is this system live (really submits), or still in dry run? */
export function isLive(sp: Settings['sitePilot'], ats: string): boolean {
  return sp.liveAts.includes(ats) || (sp.liveAts.includes('other') && !(ATS_NAME as Record<string, string>)[ats]);
}

export interface SpDeps {
  settings: () => Settings;
  /** Facts block and profile text for the agent prompt. */
  profile: () => Promise<{ facts: string; profile: string }>;
}

export class SitePilot {
  constructor(private deps: SpDeps) {}
  /** Told which model answered (for the AI report). */
  onModel?: (model: string) => void;
  /** Told how each job ended (for the AI report). */
  onFinished?: (outcome: SpOutcome) => void;

  private get s() {
    return this.deps.settings();
  }

  async status() {
    return { ...(await loadSpState()), counts: await counts() };
  }

  async start() {
    const st = await loadSpState();
    st.running = true;
    st.phase = 'idle';
    st.cur = undefined;
    this.knownTab = st.tabId ?? null;
    const live = this.s.sitePilot.liveAts;
    await save(st, `Site Pilot started (${live.length ? `live on ${live.map((a) => (ATS_NAME as Record<string, string>)[a] ?? a).join(', ')}, dry run elsewhere` : 'dry run everywhere'})`);
    await this.tick();
  }

  async stop(reason = 'Stopped by you') {
    const st = await loadSpState();
    await Promise.all([TICK, WATCH, LOAD].map((a) => chrome.alarms.clear(a)));
    if (st.cur?.jobId) {
      // The job goes back to the queue unless it was already sent.
      await spDb().jobs.where('id').equals(st.cur.jobId).modify((j) => {
        if (j.status === 'working') j.status = 'queued';
      });
    }
    await releaseTab(st.tabId);
    st.running = false;
    st.phase = 'stopped';
    st.cur = undefined;
    st.nextAt = undefined;
    st.waiting = undefined;
    await save(st, reason);
  }

  async resume() {
    const st = await loadSpState();
    if (!st.running) return;
    const alarms = await Promise.all([TICK, WATCH, LOAD].map((a) => chrome.alarms.get(a)));
    if (alarms.some(Boolean) && !st.cur) return;
    if (st.cur?.jobId) {
      await spDb().jobs.where('id').equals(st.cur.jobId).modify((j) => {
        if (j.status === 'working') j.status = 'queued';
      });
    }
    st.cur = undefined;
    await save(st, 'Picking up after Brave or FormPilot restarted');
    await this.tick();
  }

  /** Pause: stop now (the page in progress is closed), keep the queue; Resume carries on. */
  async pause() {
    const st = await loadSpState();
    if (!st.running || st.paused) return;
    await Promise.all([TICK, WATCH, LOAD].map((a) => chrome.alarms.clear(a)));
    if (st.cur?.jobId) {
      await spDb().jobs.where('id').equals(st.cur.jobId).modify((j) => {
        if (j.status === 'working') j.status = 'queued';
      });
      await addStep(st.cur.jobId, 'paused by you; starts again from the beginning after Resume');
      st.resumeJob = st.cur.jobId;
    }
    st.cur = undefined;
    st.paused = true;
    st.phase = 'paused';
    st.nextAt = undefined;
    st.waiting = undefined;
    if (st.tabId !== undefined) await chrome.tabs.update(st.tabId, { url: 'about:blank' }).catch(() => {});
    await save(st, 'Paused by you. Resume carries on with the queue.');
  }

  async unpause() {
    const st = await loadSpState();
    if (!st.running) return this.start();
    if (!st.paused) return;
    st.paused = false;
    st.phase = 'idle';
    // You entered the emailed code: check that page for the confirmation (no reload).
    if (st.held && st.tabId !== undefined && st.held.tabId === st.tabId) {
      const id = st.held.jobId;
      st.held = undefined;
      st.cur = { jobId: id, stage: 'apply', startedAt: Date.now(), lastActivity: Date.now(), round: 20, actions: 0, submitted: 1, busy: false, restarts: 0 };
      st.phase = 'working';
      await save(st, 'Resumed: checking the application you confirmed with the code');
      await at(WATCH, Date.now() + 60_000);
      return this.startRound(st);
    }
    st.held = undefined;
    await save(st, 'Resumed');
    await this.tick(true);
  }

  async runNow() {
    const st = await loadSpState();
    if (!st.running) return this.start();
    if (st.cur) return;
    await chrome.alarms.clear(TICK);
    await this.tick(true);
  }

  async add(jobs: NewJob[]) {
    const r = await enqueue(jobs);
    if (r.added) {
      const st = await loadSpState();
      await save(st, `Queue: ${r.added} added${r.known ? `, ${r.known} already known` : ''}`);
      if (st.running && !st.cur && st.phase === 'idle') {
        await chrome.alarms.clear(TICK);
        await at(TICK, Date.now() + 5_000);
      }
    }
    return r;
  }

  async onAlarm(name: string) {
    if (name === TICK) await this.tick();
    else if (name === WATCH) await this.watchdog();
    else if (name === LOAD) await this.pageLoaded(true);
  }

  // ---------------- window ----------------

  private async ensureTab(st: SpState, url: string): Promise<number | undefined> {
    if (st.tabId !== undefined) {
      const ok = await chrome.tabs.update(st.tabId, { url, active: true }).catch(() => null);
      if (ok) return st.tabId;
    }
    const win = await chrome.windows.create({ url, focused: false, type: 'normal', state: 'normal', width: 1280, height: 920 }).catch((e) => (log.warn('could not open the Site Pilot window', e), null));
    const tabId = win?.tabs?.[0]?.id;
    if (!win || tabId === undefined) return undefined;
    st.windowId = win.id;
    st.tabId = tabId;
    this.knownTab = tabId;
    return tabId;
  }

  async onWindowRemoved(windowId: number) {
    const st = await loadSpState();
    if (st.windowId !== windowId) return;
    st.windowId = undefined;
    st.tabId = undefined;
    this.knownTab = null;
    if (!st.running) return save(st);
    // Closed (by you, or by a reload): the job in progress goes back to the queue and Site Pilot
    // carries on in a new window after a short pause. Stop is the button for stopping.
    if (st.cur?.jobId) {
      await spDb().jobs.where('id').equals(st.cur.jobId).modify((j) => {
        if (j.status === 'working') j.status = 'queued';
      });
    }
    st.cur = undefined;
    st.phase = 'pause';
    st.nextAt = Date.now() + 60_000;
    await Promise.all([LOAD, WATCH].map((a) => chrome.alarms.clear(a)));
    await save(st, 'Site Pilot window was closed; opening a new one in a minute (use Stop to stop)');
    await at(TICK, st.nextAt);
  }

  /** The page in Site Pilot's tab finished loading. */
  /**
   * A page in Site Pilot's tab opened another tab (an "Apply" that opens in a new tab, a popup):
   * Site Pilot works in one tab, so it closes the new one and, if it was the way to the form,
   * goes there in its own tab.
   */
  async onTabCreated(tab: chrome.tabs.Tab) {
    const id = tab.id;
    if (id === undefined) return;
    // Chromium doesn't always fill in openerTabId on onCreated: read the tab again shortly after.
    if (tab.openerTabId === undefined) {
      await new Promise((r) => setTimeout(r, 400));
      tab = (await chrome.tabs.get(id).catch(() => null)) ?? tab;
      if (tab.openerTabId === undefined) return;
    }
    const st = await loadSpState();
    if (!st.running || tab.openerTabId !== st.tabId) return;
    await new Promise((r) => setTimeout(r, 1500)); // let it get its address
    const t = await chrome.tabs.get(id).catch(() => null);
    const url = t?.pendingUrl || t?.url || '';
    await chrome.tabs.remove(id).catch(() => {});
    if (!st.cur || !/^https?:/i.test(url)) return;
    await addStep(st.cur.jobId, `closed a tab the page opened (${url.slice(0, 100)})`);
    if (st.cur.stage === 'resolve' && !onHop(url)) return this.resolved({ url });
    if (st.cur.stage === 'apply' && !st.cur.submitted) {
      st.cur.busy = false;
      await save(st);
      await chrome.tabs.update(st.tabId!, { url, active: true }).catch(() => {});
    }
  }

  /** Site Pilot's tab, remembered so other tabs' updates don't each read the state. */
  private knownTab: number | null | undefined;

  async onTabUpdated(tabId: number, info: { status?: string; url?: string }, tab: chrome.tabs.Tab) {
    if (this.knownTab !== undefined && tabId !== this.knownTab) return;
    const st = await loadSpState();
    this.knownTab = st.running && st.tabId !== undefined ? st.tabId : null;
    if (!st.running || tabId !== st.tabId || !st.cur) return;
    // Naukri sometimes sends the tab itself to the company site.
    // After a server redirect Chrome may report the final address only on the tab, at "complete".
    const now = info.url ?? (info.status === 'complete' ? tab.url : undefined);
    if (st.cur.stage === 'resolve' && now && !onHop(now) && /^https?:/i.test(now)) {
      await this.resolved({ url: now });
      return;
    }
    if (info.status !== 'complete') return;
    if (st.cur.busy && st.cur.url && tab.url && tab.url !== st.cur.url) {
      // The page navigated during a round (Next, Submit): that round is over.
      st.cur.busy = false;
      st.cur.round++;
      await save(st);
      await addStep(st.cur.jobId, `page changed → ${tab.url.slice(0, 120)}`);
    }
    if (st.cur.busy) return;
    await at(LOAD, Date.now() + 30_000);
    setTimeout(() => void this.pageLoaded(), 2500 + Math.random() * 2000);
  }

  // ---------------- the job loop ----------------

  private async tick(force = false) {
    const st = await loadSpState();
    if (!st.running || st.paused) return;
    if (st.cur) return;
    const sp = this.s.sitePilot;
    // "Pause while you're using the Mac": wait to start a job until you're away (a job already
    // started is finished at the slow pace, so no form is left half done).
    if (!force && localRun().whenActive === 'pause' && (await userActive())) {
      st.phase = 'waiting';
      st.nextAt = Date.now() + 60_000;
      await save(st, st.phase === 'waiting' && st.message.startsWith('Waiting') ? undefined : `Waiting until you've been away from the Mac for ${localRun().idleMinutes} min`);
      await at(TICK, st.nextAt);
      return;
    }
    const job = await nextQueued(st.resumeJob);
    if (st.resumeJob) st.resumeJob = undefined;
    if (!job) {
      if (sp.harvestBoards && Date.now() - (st.boardsAt ?? 0) > 4 * 3600_000) return this.harvestBoards(st);
      if (sp.harvestNaukri && Date.now() - (st.harvest?.at ?? 0) > 45 * 60_000) return this.harvest(st);
      st.phase = 'idle';
      st.nextAt = Date.now() + 15 * 60_000;
      await save(st, st.message.startsWith('Queue is empty') ? undefined : `Queue is empty. Looking again at ${fmt(st.nextAt)}`);
      await at(TICK, st.nextAt);
      return;
    }
    // Checks that need no page.
    const ap = this.s.autopilot;
    if (job.title && titleSkipped(job.title, ap.skipWords)) return this.finishQuick(st, job, 'skipped', `title has a skip word ("${job.title}")`);
    if (job.company && (await companyCount(job.company, job.id)) >= sp.perCompany) return this.finishQuick(st, job, 'skipped', `already ${sp.perCompany} applications to ${job.company} in 30 days`);
    if (needsAccount(job.url)) return this.finishQuick(st, job, 'needs-you', 'this site needs an account (sign in and apply yourself)');
    // Another job at this company already hit a CAPTCHA or a sign-in wall: don't open this one.
    const wall = job.company ? await companyWall(job.company, job.id) : null;
    if (wall) return this.finishQuick(st, job, 'needs-you', `same company as an earlier job: ${wall}`);

    // Known company link from an earlier try: go straight there.
    const naukri = (/naukri\.com\/job-listings/i.test(job.url) || BOARD_JOB.test(job.url)) && !job.applyUrl;
    await spDb().jobs.update(job.id, { status: 'working', startedAt: Date.now(), updatedAt: Date.now(), attempts: job.attempts + 1 });
    st.cur = { jobId: job.id, stage: naukri ? 'resolve' : 'apply', startedAt: Date.now(), lastActivity: Date.now(), round: 0, actions: 0, submitted: 0, busy: false, restarts: 0 };
    st.phase = 'working';
    st.nextAt = undefined;
    await save(st, `Working on: ${job.title || job.url}${job.company ? ` · ${job.company}` : ''}`);
    await addStep(job.id, naukri ? (BOARD_JOB.test(job.url) ? 'opening the job board page to follow its Apply link' : 'opening the Naukri job to follow "Apply on company site"') : `opening ${job.url.slice(0, 120)}`);
    const tabId = await this.ensureTab(st, naukri ? job.url : job.applyUrl || job.url);
    if (tabId === undefined) return this.finish('failed', 'could not open the Site Pilot window');
    // Its window sits behind yours: keep the page running at full speed (same as the Autopilot's tab).
    await keepTabAwake(tabId);
    await save(st);
    await at(WATCH, Date.now() + 60_000);
    await at(LOAD, Date.now() + 40_000);
  }

  /** A job that's settled without opening it. */
  private async finishQuick(st: SpState, job: SpJob, outcome: SpOutcome, reason: string) {
    await spDb().jobs.update(job.id, { status: outcome, reason, doneAt: Date.now(), updatedAt: Date.now() });
    await save(st, `${outcome === 'skipped' ? 'Skipped' : 'Left for you'}: ${job.title || job.url} · ${reason}`);
    await at(TICK, Date.now() + 3_000);
  }

  /** The page loaded (or the load alarm fired): start the next step for the current job. */
  private async pageLoaded(fromAlarm = false) {
    const st = await loadSpState();
    if (!st.running || !st.cur || st.tabId === undefined) return;
    const cur = st.cur;
    // Naukri never handed over the link (the load alarm is the time limit for that).
    if (cur.stage === 'resolve' && cur.busy) {
      if (fromAlarm) return this.resolved({ reason: 'the job page did not lead to the company link in time' });
      return;
    }
    if (cur.busy) return;
    await chrome.alarms.clear(LOAD);
    if (cur.stage === 'harvest') return this.harvestRead(st);
    if (cur.stage === 'resolve') {
      const tab = await chrome.tabs.get(st.tabId).catch(() => null);
      cur.url = tab?.url;
      cur.busy = true;
      cur.lastActivity = Date.now();
      await save(st);
      await at(LOAD, Date.now() + 45_000);
      const r = (await chrome.tabs.sendMessage(st.tabId, { type: 'sp-resolve' }, { frameId: 0 }).catch((e) => ({ reason: `page did not answer (${(e as Error).message})` }))) as {
        url?: string;
        naukriApply?: boolean;
        reason?: string;
        pending?: boolean;
      };
      if (r?.pending) return; // it pressed the button; the link arrives by message or navigation
      // The page's script wasn't there yet (still loading): try again shortly.
      if (/receiving end does not exist|could not establish/i.test(r?.reason ?? '') && cur.restarts < 4) {
        cur.busy = false;
        cur.restarts++;
        await save(st);
        return at(LOAD, Date.now() + 8_000);
      }
      return this.resolved(r ?? {});
    }
    return this.startRound(st);
  }

  /** Naukri's company link (or why there isn't one). */
  async resolved(r: { url?: string; naukriApply?: boolean; reason?: string }) {
    const st = await loadSpState();
    if (!st.cur || st.cur.stage !== 'resolve' || st.tabId === undefined) return;
    const id = st.cur.jobId;
    // Naukri's own hop (it records the click, then redirects to the company): follow it; the
    // tab update with the company address finishes this step.
    if (r.url && (/naukri\.com\/.*(saveCompanyApply|apply-services|redirect)/i.test(r.url) || (onHop(r.url) && !/naukri\.com/i.test(r.url)))) {
      await addStep(id, /naukri\.com/i.test(r.url) ? 'following Naukri\'s link to the company site' : `following the job board's Apply link (${r.url.slice(0, 100)})`);
      st.cur.busy = true;
      st.cur.lastActivity = Date.now();
      await save(st);
      await chrome.tabs.update(st.tabId, { url: r.url, active: true }).catch(() => {});
      await at(LOAD, Date.now() + 45_000);
      return;
    }
    if (r.url && /^https?:\/\//i.test(r.url) && !onHop(r.url)) {
      const job = await spDb().jobs.get(id);
      await spDb().jobs.update(id, { applyUrl: r.url, via: job?.via ?? job?.url, ats: detectAts(r.url), updatedAt: Date.now() });
      await addStep(id, `company link: ${r.url.slice(0, 160)}`);
      if (needsAccount(r.url)) return this.finish('needs-you', 'the company site needs an account (sign in and apply yourself)');
      st.cur.stage = 'apply';
      st.cur.busy = false;
      st.cur.lastActivity = Date.now();
      await save(st);
      // Naukri may already have sent the tab there; otherwise open it.
      const tab = await chrome.tabs.get(st.tabId).catch(() => null);
      if (!tab?.url || tab.url !== r.url) await chrome.tabs.update(st.tabId, { url: r.url, active: true }).catch(() => {});
      await at(LOAD, Date.now() + 40_000);
      return;
    }
    if (r.naukriApply) return this.finish('skipped', 'applies on Naukri itself (the Autopilot handles these)');
    // Applied already (on Naukri, or here earlier): nothing for you to do.
    if (r.reason && /already applied/i.test(r.reason)) return this.finish('skipped', r.reason);
    return this.finish('needs-you', r.reason || 'could not get the company link from Naukri');
  }

  private async startRound(st: SpState) {
    const cur = st.cur!;
    const sp = this.s.sitePilot;
    const job = await spDb().jobs.get(cur.jobId);
    if (!job) return this.finish('failed', 'job record missing');
    if (cur.round >= 25) return this.finish('needs-you', 'too many pages; check where it stopped');
    const tab = await chrome.tabs.get(st.tabId!).catch(() => null);
    cur.url = tab?.url;
    await keepTabAwake(st.tabId!); // the worker may have restarted and dropped it
    cur.busy = true;
    cur.lastActivity = Date.now();
    await save(st);
    const ctx: RoundContext = { jobId: job.id, title: job.title, company: job.company, actionsLeft: Math.max(0, sp.maxActions - cur.actions), submitted: cur.submitted, round: cur.round, vision: sp.vision, resumeLink: sp.resumeLink };
    const ok = await chrome.tabs.sendMessage(st.tabId!, { type: 'sp-round', ctx }, { frameId: 0 }).catch((e) => (log.info(`round not started: ${(e as Error).message}`), null));
    if (!ok) {
      cur.busy = false;
      cur.restarts++;
      await save(st);
      if (cur.restarts > 4) return this.finish('needs-you', 'the page never answered (blank or blocked page)');
      await at(LOAD, Date.now() + 30_000);
    }
  }

  /** A round in the page ended. */
  async onRoundDone(r: RoundResult, tabId?: number) {
    const st = await loadSpState();
    if (!st.cur || tabId !== st.tabId) return;
    const cur = st.cur;
    // The page is still working on an earlier round (after a reload): let that one finish.
    if (r.kind === 'continue' && r.busy) {
      cur.busy = true;
      cur.lastActivity = Date.now();
      await save(st);
      return;
    }
    cur.busy = false;
    cur.round++;
    cur.actions += r.actions ?? 0;
    cur.lastActivity = Date.now();
    await save(st);
    if (r.answers?.length || r.ats) {
      await spDb().jobs.where('id').equals(cur.jobId).modify((j) => {
        if (r.ats) j.ats = r.ats;
        if (r.answers?.length) {
          const byQ = new Map(j.answers.map((a) => [a.q, a]));
          for (const a of r.answers!) byQ.set(a.q, a);
          j.answers = [...byQ.values()].slice(0, 120);
        }
      });
    }
    if (r.kind === 'done') return this.finish(r.outcome, r.reason);
    if (r.note) await addStep(cur.jobId, r.note);
    if (cur.actions >= this.s.sitePilot.maxActions) return this.finish('needs-you', `used ${cur.actions} actions without finishing; check where it stopped`);
    // Same page, more to do (a step that didn't navigate): next round shortly.
    setTimeout(() => void this.pageLoaded(), 1500);
    await at(LOAD, Date.now() + 35_000);
  }

  private async watchdog() {
    const st = await loadSpState();
    if (!st.running || !st.cur) return;
    const cur = st.cur;
    const sp = this.s.sitePilot;
    if (cur.stage === 'harvest') {
      // The Naukri search never reported back: give up on it until the next look.
      if (Date.now() - cur.startedAt > 4 * 60_000) {
        st.cur = undefined;
        st.phase = 'idle';
        await save(st, 'Naukri search did not load; looking again later');
        return at(TICK, Date.now() + 15 * 60_000);
      }
      return at(WATCH, Date.now() + 60_000);
    }
    if (Date.now() - cur.startedAt > sp.maxMinutes * 60_000) {
      await this.shot('stuck').catch(() => {});
      return this.finish('needs-you', `took more than ${sp.maxMinutes} min; check where it stopped`);
    }
    // A round that went quiet (the page navigated without a load event, or the script died).
    if (Date.now() - cur.lastActivity > 5 * 60_000) {
      cur.busy = false;
      cur.restarts++;
      cur.lastActivity = Date.now();
      await save(st);
      if (cur.restarts > 4) return this.finish('needs-you', 'the page stopped responding');
      void this.pageLoaded();
    }
    await at(WATCH, Date.now() + 60_000);
  }

  /** Content reports activity (keeps the watchdog quiet). */
  async onProgress(text: string, tabId?: number) {
    const st = await loadSpState();
    if (!st.cur || tabId !== st.tabId) return;
    st.cur.lastActivity = Date.now();
    await save(st);
    if (text) await addStep(st.cur.jobId, text);
  }

  /** Content asks: may I press Submit? Live systems: yes (at most twice per job). Dry run: no. */
  async onSubmit(ats: string, tabId?: number): Promise<{ allow: 'live' | 'dry' | 'no' }> {
    const st = await loadSpState();
    if (!st.cur || tabId !== st.tabId) return { allow: 'no' };
    if (!isLive(this.s.sitePilot, ats)) return { allow: 'dry' };
    if (st.cur.submitted >= 2) return { allow: 'no' };
    st.cur.submitted++;
    st.cur.lastActivity = Date.now();
    await save(st);
    await addStep(st.cur.jobId, `pressing Submit (${st.cur.submitted === 1 ? 'first' : 'second'} time)`);
    return { allow: 'live' };
  }

  /** Screenshot of Site Pilot's window, saved with the job. */
  async shot(kind: 'form' | 'before-submit' | 'confirmation' | 'stuck' | 'look'): Promise<{ id: string; data: string } | null> {
    const st = await loadSpState();
    if (st.windowId === undefined || !st.cur) return null;
    const tab = await chrome.tabs.get(st.tabId!).catch(() => null);
    if (tab && !tab.active) await chrome.tabs.update(st.tabId!, { active: true }).catch(() => {});
    const data = await chrome.tabs.captureVisibleTab(st.windowId, { format: 'jpeg', quality: 62 }).catch((e) => (log.info(`screenshot failed: ${(e as Error).message}`), ''));
    if (!data) return null;
    const id = await addShot(st.cur.jobId, kind, data);
    return { id, data };
  }

  /** The model looks at the page and picks one action. */
  async agent(snap: PageSnapshot, history: string[], tabId?: number): Promise<AgentAction> {
    const st = await loadSpState();
    if (!st.cur || tabId !== st.tabId) return { do: 'stop', why: 'not the Site Pilot tab' };
    const job = await spDb().jobs.get(st.cur.jobId);
    const sp = this.s.sitePilot;
    const pic = sp.vision ? await this.shot('look') : null;
    const { facts, profile } = await this.deps.profile();
    const prompt = buildAgentPrompt({ snap, job: { title: job?.title ?? '', company: job?.company ?? '', description: job?.description }, profile, facts, history });
    const s = siteSettings(this.s);
    const t0 = Date.now();
    try {
      const r = await generateWithFallback(s, {
        system: agentSystem(this.s.sitePilot.answerStyle, this.s.sitePilot.brief),
        prompt,
        schema: ACTION_SCHEMA,
        temperature: 0.1,
        maxTokens: 400,
        thinking: 'off',
        stream: false,
        signal: AbortSignal.timeout(6 * 60_000),
        images: pic ? [pic.data.replace(/^data:image\/\w+;base64,/, '')] : undefined,
        onWait: (why) => void this.waiting(why),
      });
      const a = parseAction(r.text, snap);
      const model = r.provider.id === 'pilot-local' || r.provider.kind === 'ollama' ? `local ${r.model}` : `${r.provider.label.replace(/\s*\(.*\)$/, '')} ${r.model}`;
      this.onModel?.(model);
      void recordAiCall('sitePilot', model, { ms: Date.now() - t0, asked: 1, answered: a.do === 'stop' && /no usable|unknown|bad /.test(a.why) ? 0 : 1, fallback: this.s.pilotAi.sitePilot.mode === 'cloud-then-local' && model.startsWith('local ') });
      await this.waiting(undefined);
      await addStep(st.cur.jobId, `model (${Math.round((Date.now() - t0) / 1000)} s): ${describeAction(a, snap)}${'why' in a ? '' : ''}`);
      return a;
    } catch (e) {
      await this.waiting(undefined);
      log.warn('agent call failed', e);
      return { do: 'stop', why: `local model failed: ${(e as Error).message.slice(0, 120)}` };
    }
  }

  private async waiting(why: string | undefined) {
    const st = await loadSpState();
    if (st.waiting === why) return;
    st.waiting = why;
    if (st.cur) st.cur.lastActivity = Date.now();
    await save(st);
  }

  /** The resume file for upload fields. */
  async resumeFile(): Promise<{ name: string; type: string; b64: string } | null> {
    const f = await spDb().files.get('resume');
    if (!f) return null;
    const bytes = new Uint8Array(f.data);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { name: f.name, type: f.type, b64: btoa(bin) };
  }

  /** Job over: record it, then pause before the next one. */
  async finish(outcome: SpOutcome, reason: string) {
    const st = await loadSpState();
    const cur = st.cur;
    if (!cur) return;
    // Submitted, and the site emailed a code to confirm (Greenhouse does this): only you can read
    // it. The page stays open in Site Pilot's window, Site Pilot pauses, and Resume checks it.
    // Only while you're at the Mac: overnight (nobody to type the code) it is filed under Needs you
    // and Site Pilot goes on with the next job.
    const someoneHere = (await chrome.idle?.queryState(600).catch(() => 'active')) === 'active';
    if (outcome === 'needs-you' && cur.submitted && someoneHere && /\b(verification|security|confirmation) code\b|\bcode (was )?sent\b|\botp\b/i.test(reason)) {
      const job = await spDb().jobs.get(cur.jobId);
      await addStep(cur.jobId, 'the site emailed you a code: type it in Site Pilot\'s window and press Submit, then Resume');
      await Promise.all([LOAD, WATCH, TICK].map((a) => chrome.alarms.clear(a)));
      st.held = { jobId: cur.jobId, tabId: st.tabId };
      st.cur = undefined;
      st.paused = true;
      st.phase = 'paused';
      await save(st, `Paused: ${job?.company ?? 'the site'} emailed you a security code. Type it in Site Pilot's window, press Submit, then Resume.`);
      try {
        chrome.notifications?.create(`fp-sp-code-${Date.now()}`, { type: 'basic', iconUrl: chrome.runtime.getURL('icon/128.png'), title: 'Site Pilot needs a code', message: `${job?.company ?? 'A company'} emailed you a security code. Type it in Site Pilot's window, press Submit, then press Resume on the Site Pilot page.`, priority: 2, requireInteraction: true });
      } catch {
        /* notifications unavailable */
      }
      if (st.windowId !== undefined) await chrome.windows.update(st.windowId, { focused: true, drawAttention: true }).catch(() => {});
      return;
    }
    await chrome.alarms.clear(LOAD);
    await chrome.alarms.clear(WATCH);
    const job = await spDb().jobs.get(cur.jobId);
    const ats = job?.ats || detectAts(job?.applyUrl || job?.url || '');
    await spDb().jobs.update(cur.jobId, { status: outcome, reason, doneAt: Date.now(), updatedAt: Date.now(), ats, dry: outcome === 'ready' });
    await learnBoard(job?.applyUrl ?? job?.url).catch(() => {});
    await addStep(cur.jobId, `${outcome}: ${reason}`);
    this.onFinished?.(outcome);
    const label = { sent: 'Sent', ready: 'Ready (dry run, not sent)', 'needs-you': 'Needs you', skipped: 'Skipped', failed: 'Failed', unsure: 'Submitted, no confirmation seen' }[outcome];
    if (outcome === 'sent' && job && this.s.tracker.enabled && this.s.tracker.url) {
      const u = job.applyUrl || job.url;
      await recordInTracker(this.s, 'applied', { url: job.via || u, role: job.title, company: job.company, location: job.location ?? '', source: 'Company site', salary: '', description: job.description ?? '' }, job.answers.map((a) => ({ q: a.q, a: a.a })), 'FormPilot Site Pilot')
        .then(() => spDb().jobs.update(cur.jobId, { tracked: true }))
        .catch((e) => log.info(`tracker: ${(e as Error).message}`));
    }
    st.cur = undefined;
    // Leave the page (stops its scripts and timers) but keep the window for the next job; any other
    // tab that ended up in its window is closed.
    if (st.tabId !== undefined) await chrome.tabs.update(st.tabId, { url: 'about:blank' }).catch(() => {});
    if (st.windowId !== undefined) {
      const extra = (await chrome.tabs.query({ windowId: st.windowId }).catch(() => [])).filter((t) => t.id !== st.tabId && t.id !== undefined);
      if (extra.length) await chrome.tabs.remove(extra.map((t) => t.id!)).catch(() => {});
    }
    if (!st.running) return save(st, `${label}: ${job?.title ?? ''} · ${reason}`);
    const sp = this.s.sitePilot;
    const wait = outcome === 'skipped' ? 5_000 : rand(sp.pauseMinSec, sp.pauseMaxSec) * 1000;
    st.phase = 'pause';
    st.nextAt = Date.now() + wait;
    await save(st, `${label}: ${job?.title || job?.url || ''}${job?.company ? ` · ${job.company}` : ''}${ats ? ` (${(ATS_NAME as Record<string, string>)[ats] ?? ats})` : ''} · ${reason}. Next at ${fmt(st.nextAt)}`);
    await at(TICK, st.nextAt);
  }

  // ---------------- finding jobs ----------------

  /** Queue empty: read every company job board (your list + learned ones) and queue what fits. */
  private async harvestBoards(st: SpState) {
    const sp = this.s.sitePilot;
    const ap = this.s.autopilot;
    st.boardsAt = Date.now();
    st.phase = 'working';
    await save(st, 'Queue is empty: reading company job boards');
    const boards: Board[] = parseBoards([sp.boards, ...(await learnedBoards())].join(','));
    const relevant = ap.mustWords.trim() ? relevantWords(ap.mustWords.split(/[,\n]+/)) : relevantWords(titlesOf(ap));
    let found = 0;
    let added = 0;
    let failed = 0;
    for (const b of boards) {
      const jobs = await fetchBoard(b).catch(() => (failed++, []));
      const fit = fitting(jobs, { relevant, skipWords: ap.skipWords, days: sp.boardDays, senior: sp.seniorRoles, stack: sp.stack });
      found += fit.length;
      if (fit.length) added += (await enqueue(fit.map((j) => ({ url: j.url, title: j.title, company: j.company, location: j.location, description: j.description, source: 'board' as const })))).added;
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 600)); // one board at a time, politely
    }
    // Remote job boards (Himalayas, Remotive, Remote OK, We Work Remotely): jobs open to India.
    let feedNote = '';
    if (sp.remoteBoards) {
      const r = await fetchFeeds(titlesOf(ap));
      const fit = fitting(r.jobs, { relevant, skipWords: ap.skipWords, days: sp.boardDays });
      const add = fit.length ? (await enqueue(fit.map((j) => ({ url: j.url, title: j.title, company: j.company, location: j.location, description: j.description, source: 'board' as const })))).added : 0;
      found += fit.length;
      added += add;
      feedNote = `; remote boards: ${r.read} read${r.failed ? ` (${r.failed} didn't answer)` : ''}, ${fit.length} fit`;
    }
    const now = await loadSpState();
    if (!now.running) return;
    now.phase = 'idle';
    now.boardsAt = st.boardsAt;
    await save(now, `Job boards: ${boards.length} read${failed ? ` (${failed} didn't answer)` : ''}${feedNote}, ${found} jobs fit, ${added} new in the queue`);
    await at(TICK, Date.now() + (added ? 5_000 : 60_000));
  }

  /** Queue empty: read a Naukri search (newest jobs for the next title) and queue what fits. */
  private async harvest(st: SpState) {
    const ap = this.s.autopilot;
    const titles = titlesOf(ap);
    if (!titles.length) {
      st.harvest = { i: 0, at: Date.now() };
      return save(st);
    }
    const i = ((st.harvest?.i ?? -1) + 1) % titles.length;
    st.harvest = { i, at: Date.now() };
    st.cur = { jobId: '', stage: 'harvest', startedAt: Date.now(), lastActivity: Date.now(), round: 0, actions: 0, submitted: 0, busy: false, restarts: 0 };
    st.phase = 'working';
    await save(st, `Queue is empty: looking for company-site jobs on Naukri for "${titles[i]}"`);
    const tabId = await this.ensureTab(st, naukriSearchUrl(titles[i], Math.max(1, ap.postedDays)));
    if (tabId === undefined) {
      st.cur = undefined;
      st.phase = 'idle';
      await save(st, 'could not open the Site Pilot window');
      return at(TICK, Date.now() + 15 * 60_000);
    }
    await save(st);
    await at(LOAD, Date.now() + 40_000);
    await at(WATCH, Date.now() + 60_000);
  }

  private async harvestRead(st: SpState) {
    const ap = this.s.autopilot;
    const r = (await chrome.tabs.sendMessage(st.tabId!, { type: 'command', name: 'site-list', platform: 'naukri' }, { frameId: 0 }).catch(() => null)) as { jobs?: SiteJob[] } | null;
    const relevant = ap.mustWords.trim() ? relevantWords(ap.mustWords.split(/[,\n]+/)) : relevantWords(titlesOf(ap));
    const fit = (r?.jobs ?? []).filter((j) => !j.applied && titleRelevant(j.title, relevant) && !titleSkipped(j.title, ap.skipWords) && (j.expMin === undefined || j.expMin <= ap.naukri.maxExpMin));
    const added = await enqueue(fit.map((j) => ({ url: j.url, title: j.title, company: j.company, location: j.location, source: 'naukri' as const, via: j.url })));
    st.cur = undefined;
    st.phase = 'idle';
    await chrome.alarms.clear(WATCH);
    await save(st, `Naukri search: ${r?.jobs?.length ?? 0} jobs, ${fit.length} fit, ${added.added} new in the queue`);
    await at(TICK, Date.now() + (added.added ? 8_000 : 15 * 60_000));
  }
}

export type { Ats };
