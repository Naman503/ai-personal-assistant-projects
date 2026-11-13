/**
 * Optional job tracker client (background only).
 *
 * Talks to a Job Search Desk compatible server:
 *   POST /api/record-application  {kind: "applied" | "saved", url, role, company, location,
 *                                  source, salary, description, answers: [{q, a}], recordedBy}
 *        -> {ok, id, created, status}
 *   GET  /api/state                -> used by "Test connection"
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

export async function recordInTracker(s: Settings, kind: 'applied' | 'saved', job: JobInfo, answers: GivenAnswer[]) {
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
    answers: (s.tracker.includeAnswers ? answers : []).slice(0, 60).map((x) => ({ q: String(x.q).slice(0, 200), a: String(x.a).slice(0, 600) })),
    recordedBy: 'FormPilot',
  };
  return call<{ ok: boolean; id: string; created: boolean; status: string }>(baseUrl(s.tracker.url) + '/api/record-application', { method: 'POST', body: JSON.stringify(payload) });
}

export async function testTracker(url: string): Promise<{ applications: number; people: number }> {
  const st = await call<{ applications?: unknown[]; contacts?: unknown[] }>(baseUrl(url) + '/api/state');
  if (!Array.isArray(st.applications)) throw new TrackerError("That address answered, but it doesn't look like a job tracker.");
  return { applications: st.applications.length, people: Array.isArray(st.contacts) ? st.contacts.length : 0 };
}
