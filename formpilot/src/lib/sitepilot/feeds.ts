/**
 * Remote job boards, read through their public feeds (checked 17 Nov 2026). Their jobs go into
 * Site Pilot's queue as board pages; Site Pilot follows each page's Apply link to the company's
 * own form (see boardResolve in content/sitepilot.ts).
 *   Himalayas          himalayas.app/jobs/api/search?q=<title>&country=IN  (only jobs open to India)
 *   Remotive           remotive.com/api/remote-jobs?search=<title>  (asks for few calls, credits)
 *   Remote OK          remoteok.com/api  (one JSON for all; asks for a link back / credit)
 *   We Work Remotely   weworkremotely.com/categories/remote-<cat>-jobs.rss  (RSS, hourly)
 * One request per feed (per title for search feeds) each time Site Pilot reads boards (every
 * 4 hours at most), with a pause between requests.
 */
import type { BoardJob } from './boards';

type Fetch = typeof fetch;
const clip = (s: unknown, n = 3000) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
const get = async (f: Fetch, url: string, json = true) => {
  const r = await f(url, { signal: AbortSignal.timeout(20_000), headers: { accept: json ? 'application/json' : 'application/rss+xml, text/xml' } });
  if (!r.ok) throw new Error(`${r.status}`);
  return json ? r.json() : r.text();
};
const sec = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : undefined;
};

export const FEEDS = ['himalayas', 'remotive', 'remoteok', 'weworkremotely'] as const;
export type Feed = (typeof FEEDS)[number];

/** Himalayas: a list of allowed countries (empty = anywhere). Keep it short for the location check. */
export function himalayasLocation(restrictions: unknown): string {
  const list = Array.isArray(restrictions) ? restrictions.map(String) : [];
  if (!list.length) return 'Remote · Worldwide';
  if (list.some((c) => /^india$/i.test(c))) return 'Remote · India';
  return `Remote · ${list.slice(0, 3).join(', ')}`;
}

export async function himalayasJobs(title: string, f: Fetch = fetch): Promise<BoardJob[]> {
  const j = (await get(f, `https://himalayas.app/jobs/api/search?${new URLSearchParams({ q: title, country: 'IN', limit: '50' })}`)) as {
    jobs?: { title: string; companyName: string; locationRestrictions?: string[]; applicationLink: string; guid?: string; pubDate?: string | number; excerpt?: string; description?: string }[];
  };
  return (j.jobs ?? []).map((x) => ({
    title: x.title,
    company: x.companyName,
    location: himalayasLocation(x.locationRestrictions),
    url: (x.applicationLink || x.guid || '').replace(/\?utm_source=api$/, ''),
    postedAt: sec(x.pubDate),
    description: clip(x.description || x.excerpt),
  }));
}

export async function remotiveJobs(title: string, f: Fetch = fetch): Promise<BoardJob[]> {
  const j = (await get(f, `https://remotive.com/api/remote-jobs?${new URLSearchParams({ search: title, limit: '50' })}`)) as {
    jobs?: { title: string; company_name: string; candidate_required_location?: string; url: string; publication_date?: string; description?: string }[];
  };
  return (j.jobs ?? []).map((x) => ({
    title: x.title,
    company: x.company_name,
    location: `Remote · ${x.candidate_required_location || 'Worldwide'}`,
    url: x.url,
    postedAt: x.publication_date ? Date.parse(x.publication_date) : undefined,
    description: clip(x.description),
  }));
}

export async function remoteOkJobs(f: Fetch = fetch): Promise<BoardJob[]> {
  const j = (await get(f, 'https://remoteok.com/api')) as { position?: string; company?: string; location?: string; url?: string; epoch?: number | string; description?: string }[];
  return (Array.isArray(j) ? j : [])
    .filter((x) => x.position && x.url)
    .map((x) => ({ title: x.position!, company: x.company ?? '', location: `Remote · ${x.location || 'Worldwide'}`, url: x.url!.replace('remoteOK.com', 'remoteok.com'), postedAt: sec(x.epoch), description: clip(x.description) }));
}

/** We Work Remotely RSS: item titles are "Company: Role", <region> says who may apply. */
export function parseWwr(xml: string): BoardJob[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const tag = (n: string) => clip((new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(m[1])?.[1] ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, ''), 4000);
    const head = tag('title');
    const i = head.indexOf(':');
    return {
      title: i > 0 ? head.slice(i + 1).trim() : head,
      company: i > 0 ? head.slice(0, i).trim() : '',
      location: `Remote · ${tag('region') || 'Anywhere'}`,
      url: tag('link') || tag('guid'),
      postedAt: tag('pubDate') ? Date.parse(tag('pubDate')) : undefined,
      description: tag('description').slice(0, 3000),
    };
  });
}

export async function wwrJobs(f: Fetch = fetch): Promise<BoardJob[]> {
  const out: BoardJob[] = [];
  for (const cat of ['full-stack-programming', 'front-end-programming', 'back-end-programming']) {
    out.push(...parseWwr(String(await get(f, `https://weworkremotely.com/categories/remote-${cat}-jobs.rss`, false))));
    await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}

/** Every remote feed for these titles. Failures are counted, not thrown. */
export async function fetchFeeds(titles: string[], f: Fetch = fetch): Promise<{ jobs: BoardJob[]; read: number; failed: number }> {
  const jobs: BoardJob[] = [];
  let read = 0;
  let failed = 0;
  const run = async (p: () => Promise<BoardJob[]>) => {
    try {
      jobs.push(...(await p()));
      read++;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 600 + Math.random() * 600));
  };
  for (const t of titles.slice(0, 6)) {
    await run(() => himalayasJobs(t, f));
    await run(() => remotiveJobs(t, f));
  }
  await run(() => remoteOkJobs(f));
  await run(() => wwrJobs(f));
  return { jobs, read, failed };
}
