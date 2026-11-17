/**
 * Portal sync: reads your own "applied" lists on Naukri and Cutshort (with your signed-in session,
 * from the background) and sends them to the tracker (POST /api/import). That catches applications
 * you made on the site itself, plus each one's recruiter status (viewed, shortlisted, not shortlisted).
 * Read-only on the job sites; nothing is sent anywhere but your tracker.
 */
import type { Settings } from './settings';
import { createLogger } from './logger';
import { importToTracker, type ImportItem } from './tracker';

const log = createLogger('portal-sync');
const KEY = 'fpPortalSync';
const ALARM = 'fp-ps-tick';
/**
 * A check, not the source of truth: FormPilot records each application in the tracker the moment
 * it's sent. This compares the portals' own lists with the tracker every 3 days (adds what was
 * applied on the site itself, updates recruiter statuses, flags mismatches). See the tracker's
 * docs/backend-design.md.
 */
const EVERY_MIN = 3 * 24 * 60;

export interface PortalSyncState {
  at?: number;
  results: Record<string, { at: number; items?: number; added?: number; updated?: number; error?: string }>;
}

/** Naukri times come as "2026-11-17 19:41:13" in India time. */
export const naukriTime = (s: string) => new Date(String(s).replace(' ', 'T') + '+05:30').toISOString();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

interface NaukriRow { jobId: string; jobTitle: string; company: string; location?: string; logoPath?: string; status?: { statusValue: string; dateTime: string }[] }
/** One row of Naukri's apply history → a tracker import item. */
export function naukriItem(a: NaukriRow): ImportItem | null {
  const events = (a.status ?? []).filter((s) => s?.statusValue && s?.dateTime).map((s) => ({ status: s.statusValue, at: naukriTime(s.dateTime) }));
  const applied = events.find((e) => e.status === 'Applied') ?? events[0];
  if (!a.jobId || !a.jobTitle || !applied) return null;
  return { url: `https://www.naukri.com/job-listings-${slug(`${a.jobTitle} ${a.company}`)}-${a.jobId}`, role: a.jobTitle, company: a.company || '', location: a.location || '', logo: a.logoPath || '', appliedAt: applied.at, events };
}

interface CutshortRow { _id: string; creationDate?: string; resumeSeen?: boolean; lastMsgDate?: string; lastMsgText?: string; jobSignal?: { headline?: string; publicUrl?: string; locations?: string[] }; jobSignalContext?: { headline?: string; publicUrl?: string; locations?: string[] }; companyDetails?: { name?: string; logo?: string } }
/** One Cutshort application (tab = which list it came from) → a tracker import item. */
export function cutshortItem(r: CutshortRow, tab: 'awaiting' | 'shortlisted' | 'nottakenforward' | 'replied'): ImportItem | null {
  const job = r.jobSignal?.headline ? r.jobSignal : r.jobSignalContext;
  if (!r._id || !r.creationDate || !job?.headline) return null;
  const last = r.lastMsgDate || r.creationDate;
  const events = [{ status: 'Applied', at: r.creationDate }];
  if (tab === 'awaiting' && r.resumeSeen) events.push({ status: 'Resume Viewed', at: last });
  if (tab === 'shortlisted') events.push({ status: 'Shortlisted', at: last });
  if (tab === 'nottakenforward') events.push({ status: 'Not Shortlisted', at: last });
  if (tab === 'replied') events.push({ status: /not a (good )?fit/i.test(r.lastMsgText || '') ? 'Not Shortlisted' : 'Contacted by recruiter', at: last });
  return {
    url: job.publicUrl || `https://cutshort.io/profile/candidate-conversations?thread=${r._id}`,
    role: job.headline,
    company: r.companyDetails?.name || 'Unknown company',
    location: (job.locations ?? []).join(', '),
    logo: r.companyDetails?.logo || '',
    appliedAt: r.creationDate,
    events,
  };
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw new Error('not signed in');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('not signed in (got a page, not data)');
  }
}

export async function naukriApplied(days = 30): Promise<ImportItem[]> {
  const out: ImportItem[] = [];
  let total = 1;
  for (let page = 1; out.length < total && page <= 40; page++) {
    const j = await getJson(`https://www.naukri.com/cloudgateway-apply/whtma-services/v0/applyapi/v5/history?pageSize=50&days=${days}&filterInfo=2&pageNumber=${page}`, { appid: '105', systemid: 'Naukri' });
    total = Number(j.matchingRowsCount) || 0;
    const rows: NaukriRow[] = j.applyDetails ?? [];
    if (!rows.length) break;
    for (const r of rows) { const it = naukriItem(r); if (it) out.push(it); }
  }
  return out;
}

export async function cutshortApplied(): Promise<ImportItem[]> {
  const byId = new Map<string, ImportItem>();
  for (const tab of ['replied', 'awaiting', 'shortlisted', 'nottakenforward'] as const) {
    let pages = 1;
    for (let page = 1; page <= pages && page <= 60; page++) {
      const j = await getJson(`https://cutshort.io/conversations-v2/candidate?page=${page}&user_role=candidate${tab === 'replied' ? '' : `&convo_status=${tab}`}`);
      pages = Number(j.totalPages) || 0;
      for (const r of (j.results ?? []) as CutshortRow[]) { const it = cutshortItem(r, tab); if (it) byId.set(r._id, it); }
    }
  }
  return [...byId.values()];
}

export class PortalSync {
  private running = false;
  constructor(private getSettings: () => Settings) {}

  private on() {
    const t = this.getSettings().tracker;
    return t.enabled && !!t.url && t.portalSync;
  }

  /** Keep the alarm in step with the setting; sync now if the last one is old. */
  async sync() {
    if (!this.on()) { await chrome.alarms?.clear(ALARM); return; }
    // (Re)create it when missing or still on the old 2-hour period.
    const a = await chrome.alarms?.get(ALARM);
    if (!a || a.periodInMinutes !== EVERY_MIN) chrome.alarms?.create(ALARM, { delayInMinutes: a ? EVERY_MIN : 1, periodInMinutes: EVERY_MIN });
    const st = await this.state();
    if (!st.at || Date.now() - st.at > EVERY_MIN * 60_000) void this.run();
  }

  onAlarm(name: string) {
    if (name === ALARM && this.on()) void this.run();
  }

  async state(): Promise<PortalSyncState> {
    const r = await chrome.storage.local.get(KEY);
    return (r[KEY] as PortalSyncState) ?? { results: {} };
  }

  async run(): Promise<PortalSyncState> {
    if (this.running) return this.state();
    this.running = true;
    const st = await this.state();
    try {
      const url = this.getSettings().tracker.url;
      const jobs: [string, () => Promise<ImportItem[]>][] = [['Naukri', () => naukriApplied(30)], ['Cutshort', cutshortApplied]];
      for (const [portal, read] of jobs) {
        try {
          const items = await read();
          const res = await importToTracker(url, portal, items);
          st.results[portal] = { at: Date.now(), items: items.length, added: res.added, updated: res.updated };
          log.info(`${portal}: ${items.length} applications read, ${res.added} new in the tracker`);
        } catch (e) {
          st.results[portal] = { at: Date.now(), error: String((e as Error)?.message || e) };
          log.warn(`${portal}: sync failed`, e);
        }
      }
      st.at = Date.now();
      await chrome.storage.local.set({ [KEY]: st });
    } finally {
      this.running = false;
    }
    return st;
  }
}
