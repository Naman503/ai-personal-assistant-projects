/**
 * Site Pilot's own records (IndexedDB): the queue, every application with its answers and steps,
 * screenshots, and the resume file it uploads. Separate from FormPilot's memory database.
 */
import Dexie, { type EntityTable } from 'dexie';
import type { SpAnswer, SpOutcome } from './types';
import { companyKey, linkKey } from './detect';

export type SpStatus = 'queued' | 'working' | SpOutcome;

export type SpSource = 'naukri' | 'naukri-form' | 'manual' | 'linkedin' | 'autopilot';

export interface SpJob {
  id: string;
  /** Where to start: the company's form, or a Naukri job page to click through. */
  url: string;
  /** The company form it ended up on. */
  applyUrl?: string;
  title: string;
  company: string;
  location?: string;
  source: SpSource;
  /** For Naukri jobs: the Naukri page (kept for the record). */
  via?: string;
  status: SpStatus;
  ats?: string;
  reason?: string;
  /** Short description of the job, for tailored answers. */
  description?: string;
  addedAt: number;
  updatedAt: number;
  startedAt?: number;
  doneAt?: number;
  attempts: number;
  answers: SpAnswer[];
  steps: { t: number; what: string }[];
  /** Screenshot ids, oldest first. */
  shots: string[];
  /** Sent while the system was in dry run (would have applied). */
  dry?: boolean;
  /** Recorded in the job tracker. */
  tracked?: boolean;
}

export interface SpShot {
  id: string;
  jobId: string;
  at: number;
  kind: 'form' | 'before-submit' | 'confirmation' | 'stuck' | 'look';
  /** JPEG data URL. */
  data: string;
}

export interface SpFile {
  key: 'resume';
  name: string;
  type: string;
  size: number;
  data: ArrayBuffer;
  updatedAt: number;
}

class SiteDb extends Dexie {
  jobs!: EntityTable<SpJob, 'id'>;
  shots!: EntityTable<SpShot, 'id'>;
  files!: EntityTable<SpFile, 'key'>;
  constructor() {
    super('formpilot-sitepilot');
    this.version(1).stores({
      jobs: 'id, status, addedAt, updatedAt, doneAt, source',
      shots: 'id, jobId, at',
      files: 'key',
    });
  }
}

let instance: SiteDb | null = null;
export function spDb(): SiteDb {
  return (instance ??= new SiteDb());
}

const uid = () => `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export interface NewJob {
  url: string;
  title?: string;
  company?: string;
  location?: string;
  source: SpSource;
  via?: string;
  description?: string;
}

/**
 * Add jobs to the queue. A job already in the records (same link, or same Naukri page, or the
 * same company + title) is not added twice. Returns how many were added.
 */
export async function enqueue(jobs: NewJob[]): Promise<{ added: number; known: number }> {
  const db = spDb();
  const all = await db.jobs.toArray();
  const links = new Set(all.flatMap((j) => [linkKey(j.url), j.applyUrl ? linkKey(j.applyUrl) : '', j.via ? linkKey(j.via) : ''].filter(Boolean)));
  const pairs = new Set(all.filter((j) => j.company && j.title).map((j) => `${companyKey(j.company)}|${j.title.toLowerCase().trim()}`));
  let added = 0;
  let known = 0;
  const now = Date.now();
  for (const j of jobs) {
    if (!/^https?:\/\//i.test(j.url)) continue;
    const pair = j.company && j.title ? `${companyKey(j.company)}|${j.title.toLowerCase().trim()}` : '';
    if (links.has(linkKey(j.url)) || (j.via && links.has(linkKey(j.via))) || (pair && pairs.has(pair))) {
      known++;
      continue;
    }
    links.add(linkKey(j.url));
    if (pair) pairs.add(pair);
    await db.jobs.add({
      id: uid(),
      url: j.url,
      title: (j.title ?? '').trim(),
      company: (j.company ?? '').trim(),
      location: j.location,
      source: j.source,
      via: j.via,
      description: j.description?.slice(0, 4000),
      status: 'queued',
      addedAt: now + added,
      updatedAt: now,
      attempts: 0,
      answers: [],
      steps: [],
      shots: [],
    });
    added++;
  }
  return { added, known };
}

/** The next job to work on: yours first, then Google Forms from recruiters, then the rest, oldest first. */
export async function nextQueued(): Promise<SpJob | undefined> {
  const q = await spDb().jobs.where('status').equals('queued').sortBy('addedAt');
  const rank = (j: SpJob) => (j.source === 'manual' ? 0 : j.source === 'naukri-form' ? 1 : 2);
  return q.sort((a, b) => rank(a) - rank(b) || a.addedAt - b.addedAt)[0];
}

/** Applications to this company in the last 30 days (sent, or ready in dry run). */
export async function companyCount(company: string, exceptId?: string): Promise<number> {
  const k = companyKey(company);
  if (!k) return 0;
  const since = Date.now() - 30 * 86400_000;
  const done = await spDb().jobs.where('status').anyOf(['sent', 'ready', 'unsure']).toArray();
  return done.filter((j) => j.id !== exceptId && (j.doneAt ?? 0) > since && companyKey(j.company) === k).length;
}

export async function addStep(id: string, what: string) {
  await spDb().jobs.where('id').equals(id).modify((j) => {
    j.steps = [...j.steps, { t: Date.now(), what }].slice(-120);
    j.updatedAt = Date.now();
  });
}

export async function addShot(jobId: string, kind: SpShot['kind'], data: string): Promise<string> {
  const id = uid();
  await spDb().shots.add({ id, jobId, at: Date.now(), kind, data });
  await spDb().jobs.where('id').equals(jobId).modify((j) => void (j.shots = [...j.shots, id].slice(-20)));
  // Keep screenshots of the last 400 jobs' worth (about 1–2 MB per job at most).
  const n = await spDb().shots.count();
  if (n > 2500) {
    const old = await spDb().shots.orderBy('at').limit(n - 2500).primaryKeys();
    await spDb().shots.bulkDelete(old);
  }
  return id;
}

export async function counts(): Promise<Record<SpStatus, number>> {
  const out = { queued: 0, working: 0, sent: 0, ready: 0, 'needs-you': 0, skipped: 0, failed: 0, unsure: 0 } as Record<SpStatus, number>;
  await spDb().jobs.each((j) => void (out[j.status] = (out[j.status] ?? 0) + 1));
  return out;
}
