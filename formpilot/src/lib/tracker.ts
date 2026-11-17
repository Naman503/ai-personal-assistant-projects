/**
 * Optional job tracker client (background only).
 *
 * Talks to a Job Search Desk compatible server:
 *   POST /api/record-application  {kind: "applied" | "saved", url, role, company, location,
 *                                  source, salary, description, answers: [{q, a}], recordedBy}
 *        -> {ok, id, created, status}
 *   GET  /api/state                -> used by "Test connection"
 *   GET  /api/outreach/next, POST /api/outreach/result  -> LinkedIn outreach tasks (when turned on)
 *   POST /api/import {portal, items}  -> your applied lists from Naukri/Cutshort (portal sync, when on)
 * Only what's listed above is sent, and only to the URL you set.
 */
import type { Settings } from './settings';
import type { GivenAnswer, JobInfo } from './job';

export class TrackerError extends Error {}

function baseUrl(raw: string): string {
  const u = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) throw new TrackerError('Set your job tracker address in FormPilot settings → Behavior.');
  return u;
}

/** "https://x.ts.net:8444/*": the pattern Chrome/Brave site access uses for the tracker. */
export function trackerOrigin(url: string): string {
  return new URL(baseUrl(url)).origin + '/*';
}

/** Whether the browser lets FormPilot talk to the tracker (Brave and Chrome can limit site access). */
export async function hasTrackerAccess(url: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [trackerOrigin(url)] });
  } catch {
    return true;
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    // No content-type on GET: keeps it a simple request if the browser treats it as cross-site.
    const headers = init.body ? { 'content-type': 'application/json', ...(init.headers ?? {}) } : init.headers;
    res = await fetch(url, { ...init, headers, cache: 'no-store', signal: AbortSignal.timeout(12_000) });
  } catch {
    if (!(await hasTrackerAccess(url))) {
      throw new TrackerError(`FormPilot isn't allowed to reach ${new URL(url).host}. Open FormPilot settings → Behavior → Job tracker and click Test connection to allow it.`);
    }
    throw new TrackerError("Can't reach the tracker. Check the address and that you're connected (e.g. Tailscale).");
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 403) throw new TrackerError('The tracker refused this browser. Sign in to the network it allows.');
  if (!res.ok) throw new TrackerError(body?.error || `Tracker error ${res.status}`);
  return body;
}

export async function recordInTracker(s: Settings, kind: 'applied' | 'saved', job: JobInfo, answers: GivenAnswer[], recordedBy = 'FormPilot') {
  if (!s.tracker.enabled) throw new TrackerError('The job tracker is turned off in FormPilot settings.');
  const payload = {
    kind,
    url: String(job.url || '').slice(0, 2000),
    role: String(job.role || '').slice(0, 200),
    company: String(job.company || '').slice(0, 120),
    location: String(job.location || '').slice(0, 120),
    source: String(job.source || '').slice(0, 40),
    salary: String(job.salary || '').slice(0, 80),
    description: String(job.description || '').slice(0, 15000),
    logoUrl: String(job.logoUrl || '').slice(0, 2000),
    answers: (s.tracker.includeAnswers ? answers : []).slice(0, 60).map((x) => ({ q: String(x.q).slice(0, 200), a: String(x.a).slice(0, 600) })),
    recordedBy: recordedBy.slice(0, 40),
  };
  return call<{ ok: boolean; id: string; created: boolean; status: string }>(baseUrl(s.tracker.url) + '/api/record-application', { method: 'POST', body: JSON.stringify(payload) });
}

export interface TrackerLookup {
  found: boolean;
  id?: string;
  status?: string;
  label?: string;
  appliedOn?: string;
  followUp?: string;
  fit?: number;
  fitAuto?: number;
  fitWhy?: string[];
  logo?: string;
  hasDrafts?: boolean;
  linkedinNote?: string;
  people?: number;
}

/** Is this job already tracked? Needs a tracker with GET /api/lookup (Job Search Desk); older ones answer "not found". */
export async function lookupInTracker(url: string, job: { url: string; company?: string; role?: string }): Promise<TrackerLookup> {
  const q = new URLSearchParams({ url: job.url.slice(0, 2000), company: (job.company ?? '').slice(0, 120), role: (job.role ?? '').slice(0, 200) });
  try {
    return await call<TrackerLookup>(baseUrl(url) + '/api/lookup?' + q);
  } catch (e) {
    if (e instanceof TrackerError && /not found|404/i.test(e.message)) return { found: false };
    throw e;
  }
}

export interface TrackerSummary {
  toApply: number;
  toSend: number;
  due: string[];
  interviews: string[];
  waiting: number;
  week: number;
}

/** Today's counts (GET /api/digest). */
export async function trackerSummary(url: string): Promise<TrackerSummary> {
  const d = await call<Partial<TrackerSummary>>(baseUrl(url) + '/api/digest');
  return { toApply: d.toApply ?? 0, toSend: d.toSend ?? 0, due: d.due ?? [], interviews: d.interviews ?? [], waiting: d.waiting ?? 0, week: d.week ?? 0 };
}

/** LinkedIn outreach: the next task the tracker wants done (it writes any note right before answering). */
export async function outreachNext(url: string) {
  return call<import('@/entrypoints/content/linkedin-outreach').OutreachTask | { task: 'none'; reason?: string; retry?: boolean }>(baseUrl(url) + '/api/outreach/next');
}
export interface ImportItem { url: string; role: string; company: string; location: string; logo: string; appliedAt: string; events: { status: string; at: string }[] }
/** Portal sync: your applied list from a job site (POST /api/import); the tracker adds what it's missing. */
/**
 * A portal's applied list, in batches of 100 with one run id; the last batch says `final`, and the
 * tracker then flags applications FormPilot recorded that the portal doesn't list.
 */
export async function importToTracker(url: string, portal: string, items: ImportItem[]) {
  const runId = `${portal}-${Date.now()}`;
  const total = { added: 0, updated: 0, total: 0, flagged: 0 };
  for (let i = 0; i === 0 || i < items.length; i += 100) {
    const batch = items.slice(i, i + 100);
    const final = i + 100 >= items.length;
    const r = await call<{ added: number; updated: number; total: number; flagged?: number }>(baseUrl(url) + '/api/import', { method: 'POST', body: JSON.stringify({ portal, items: batch, runId, final }) });
    total.added += r.added;
    total.updated += r.updated;
    total.total += r.total;
    total.flagged += r.flagged ?? 0;
  }
  return total;
}
export async function outreachResult(url: string, body: Record<string, unknown>) {
  return call<{ ok: boolean }>(baseUrl(url) + '/api/outreach/result', { method: 'POST', body: JSON.stringify(body) });
}

export async function testTracker(url: string): Promise<{ applications: number; people: number }> {
  // The tracker's small health check (counts only); older trackers only have the full state.
  const h = await call<{ ok?: boolean; rows?: { applications?: number; contacts?: number } }>(baseUrl(url) + '/api/health').catch(() => null);
  if (h?.ok && h.rows) return { applications: h.rows.applications ?? 0, people: h.rows.contacts ?? 0 };
  const st = await call<{ applications?: unknown[]; contacts?: unknown[] }>(baseUrl(url) + '/api/state');
  if (!Array.isArray(st.applications)) throw new TrackerError("That address answered, but it doesn't look like a job tracker.");
  return { applications: st.applications.length, people: Array.isArray(st.contacts) ? st.contacts.length : 0 };
}
