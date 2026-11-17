/**
 * Job boards that companies publish through their application systems, read through the systems'
 * public job-board APIs (the same feeds companies embed on their own careers pages):
 *   Greenhouse  boards-api.greenhouse.io/v1/boards/<token>/jobs
 *   Lever       api.lever.co/v0/postings/<company>?mode=json
 *   Ashby       api.ashbyhq.com/posting-api/job-board/<org>
 *   Workable    apply.workable.com/api/v3/accounts/<sub>/jobs
 *   Recruitee   <sub>.recruitee.com/api/offers/
 *   SmartRecruiters api.smartrecruiters.com/v1/companies/<id>/postings
 * Only jobs in India, or remote jobs open to India (worldwide / APAC / no country), at your level.
 */

export const BOARD_KINDS = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters'] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];
export interface Board {
  kind: BoardKind;
  token: string;
}
export interface BoardJob {
  title: string;
  company: string;
  location: string;
  url: string;
  postedAt?: number;
  description?: string;
}

/** Boards checked live on 17 Nov 2026 with India or remote-friendly engineering roles. */
export const DEFAULT_BOARDS = [
  'greenhouse:databricks',
  'greenhouse:okta',
  'greenhouse:mongodb',
  'greenhouse:gitlab',
  'greenhouse:stripe',
  'greenhouse:turing',
  'greenhouse:glance',
  'greenhouse:inmobi',
  'greenhouse:hackerrank',
  'greenhouse:coinbase',
  'greenhouse:cloudflare',
  'greenhouse:agoda',
  'greenhouse:druva',
  'greenhouse:twilio',
  'greenhouse:stage',
  'workable:seekho',
  'ashby:supabase',
  'ashby:sarvam',
  'ashby:snowflake',
  'ashby:sentry',
  'ashby:headout',
  'ashby:atlan',
  'ashby:plaid',
  'ashby:linear',
  'lever:paytm',
  'lever:hevodata',
  'lever:fampay',
  'lever:toptal',
  'lever:zeta',
  'lever:meesho',
  'lever:cred',
].join(', ');

export function parseBoards(text: string): Board[] {
  const out: Board[] = [];
  const seen = new Set<string>();
  for (const part of text.split(/[\s,]+/)) {
    const m = part.trim().match(/^([a-z]+):([\w.-]+)$/i);
    if (!m) continue;
    const kind = m[1].toLowerCase() as BoardKind;
    if (!BOARD_KINDS.includes(kind)) continue;
    const key = `${kind}:${m[2].toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, token: m[2] });
  }
  return out;
}

/** The board a job link belongs to (to learn new boards from links seen elsewhere). */
export function boardFromUrl(url: string): Board | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(h)) {
    const t = u.searchParams.get('for') || (seg[0] !== 'embed' ? seg[0] : '');
    return t ? { kind: 'greenhouse', token: t } : null;
  }
  if (h === 'jobs.lever.co' && seg[0]) return { kind: 'lever', token: seg[0] };
  if (h === 'jobs.ashbyhq.com' && seg[0]) return { kind: 'ashby', token: seg[0] };
  if (h === 'apply.workable.com' && seg[0] && seg[0] !== 'api') return { kind: 'workable', token: seg[0] };
  if (h.endsWith('.recruitee.com')) return { kind: 'recruitee', token: h.split('.')[0] };
  if (h === 'jobs.smartrecruiters.com' && seg[0]) return { kind: 'smartrecruiters', token: seg[0] };
  return null;
}

const IND = /\b(india|bengaluru|bangalore|indore|pune|hyderabad|chennai|mumbai|gurgaon|gurugram|noida|delhi|ncr|kolkata|ahmedabad|jaipur|kochi|chandigarh|coimbatore)\b/i;
const REMOTE = /\b(remote|anywhere|worldwide|global|distributed|work from home|wfh)\b/i;
const OPEN = /\b(apac|asia|anywhere|worldwide|global|india)\b/i;

/** In India, or remote and open to India. */
export function locationOk(loc: string): boolean {
  if (IND.test(loc)) return true;
  if (!REMOTE.test(loc)) return false;
  if (OPEN.test(loc)) return true;
  // Plain "Remote" with no place named: open. "Remote · Vienna, Austria": not for India.
  return loc.split(/[·;,|/()-]+/).map((x) => x.trim()).filter(Boolean).every((part) => REMOTE.test(part) || /^(hybrid|full[- ]?time|contract)$/i.test(part));
}

/** Levels that don't fit ~3 years of experience, and roles that aren't software engineering. */
const NOT_YOUR_LEVEL = /\b(staff|principal|distinguished|manager|director|head of|vp|vice president|intern|internship|new grad|architect|fellow|lead|level [5-9])\b/i;

export function titleFits(title: string, relevant: string[], skipWords: string): boolean {
  const t = title.toLowerCase();
  if (NOT_YOUR_LEVEL.test(t)) return false;
  if (skipWords.split(/[,\n]+/).map((w) => w.trim().toLowerCase()).filter(Boolean).some((w) => t.includes(w))) return false;
  return !relevant.length || relevant.some((w) => t.includes(w));
}

type Fetch = typeof fetch;
const getJson = async (f: Fetch, url: string, init?: RequestInit) => {
  const r = await f(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};
const decodeEntities = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const clip = (s: unknown, n = 3000) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const nice = (token: string) => token.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** All open jobs on one board. */
export async function fetchBoard(b: Board, f: Fetch = fetch): Promise<BoardJob[]> {
  const co = nice(b.token);
  switch (b.kind) {
    case 'greenhouse': {
      const j = (await getJson(f, `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b.token)}/jobs?content=true`)) as { jobs?: { id: number; title: string; location?: { name?: string }; updated_at?: string; company_name?: string; content?: string }[] };
      return (j.jobs ?? []).map((x) => ({ title: x.title, company: x.company_name || co, location: x.location?.name ?? '', url: `https://job-boards.greenhouse.io/${b.token}/jobs/${x.id}`, postedAt: x.updated_at ? Date.parse(x.updated_at) : undefined, description: clip(decodeEntities(x.content ?? '')) }));
    }
    case 'lever': {
      const j = (await getJson(f, `https://api.lever.co/v0/postings/${encodeURIComponent(b.token)}?mode=json`)) as { text: string; hostedUrl: string; createdAt?: number; workplaceType?: string; categories?: { location?: string; allLocations?: string[] }; descriptionPlain?: string }[];
      return (Array.isArray(j) ? j : []).map((x) => ({
        title: x.text,
        company: co,
        location: [x.categories?.location, ...(x.categories?.allLocations ?? []), x.workplaceType === 'remote' ? 'Remote' : ''].filter(Boolean).join(' · '),
        url: `${x.hostedUrl.replace(/\/$/, '')}/apply`,
        postedAt: x.createdAt,
        description: clip(x.descriptionPlain),
      }));
    }
    case 'ashby': {
      const j = (await getJson(f, `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(b.token)}`)) as { jobs?: { title: string; jobUrl: string; location?: string; isRemote?: boolean; publishedAt?: string; secondaryLocations?: { location?: string }[]; descriptionPlain?: string; isListed?: boolean }[] };
      return (j.jobs ?? [])
        .filter((x) => x.isListed !== false)
        .map((x) => ({
          title: x.title,
          company: co,
          location: [x.location, ...(x.secondaryLocations ?? []).map((s) => s.location), x.isRemote ? 'Remote' : ''].filter(Boolean).join(' · '),
          url: `${x.jobUrl.replace(/\/$/, '')}/application`,
          postedAt: x.publishedAt ? Date.parse(x.publishedAt) : undefined,
          description: clip(x.descriptionPlain),
        }));
    }
    case 'workable': {
      const j = (await getJson(f, `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(b.token)}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '', location: [], department: [], worktype: [], remote: [] }) })) as { results?: { title: string; shortcode: string; published?: string; remote?: boolean; location?: { city?: string; country?: string } }[] };
      return (j.results ?? []).map((x) => ({
        title: x.title,
        company: co,
        location: [x.location?.city, x.location?.country, x.remote ? 'Remote' : ''].filter(Boolean).join(' · '),
        url: `https://apply.workable.com/${b.token}/j/${x.shortcode}/apply/`,
        postedAt: x.published ? Date.parse(x.published) : undefined,
      }));
    }
    case 'recruitee': {
      const j = (await getJson(f, `https://${encodeURIComponent(b.token)}.recruitee.com/api/offers/`)) as { offers?: { title: string; location?: string; country?: string; remote?: boolean; careers_apply_url?: string; careers_url?: string; published_at?: string; company_name?: string }[] };
      return (j.offers ?? []).map((x) => ({
        title: x.title,
        company: x.company_name || co,
        location: [x.location, x.country, x.remote ? 'Remote' : ''].filter(Boolean).join(' · '),
        url: x.careers_apply_url || x.careers_url || '',
        postedAt: x.published_at ? Date.parse(x.published_at) : undefined,
      }));
    }
    case 'smartrecruiters': {
      const j = (await getJson(f, `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(b.token)}/postings?limit=100`)) as { content?: { id: string; name: string; releasedDate?: string; company?: { name?: string }; location?: { city?: string; country?: string; remote?: boolean } }[] };
      return (j.content ?? []).map((x) => ({
        title: x.name,
        company: x.company?.name || co,
        location: [x.location?.city, x.location?.country, x.location?.remote ? 'Remote' : ''].filter(Boolean).join(' · '),
        url: `https://jobs.smartrecruiters.com/${b.token}/${x.id}`,
        postedAt: x.releasedDate ? Date.parse(x.releasedDate) : undefined,
      }));
    }
  }
}

/** Roles in another specialism: their title alone rules them out for a JS/TS/RN/Python profile. */
const OFF_STACK = /\b(security|kubernetes|k8s|infrastructure|infra|sre|site reliability|reliability|devops|data (platform|engineer|engineering|infrastructure)|database|storage|networking|network|compiler|runtime|kernel|embedded|firmware|hardware|ml|machine learning|research|golang|go\b|ruby|rails|java\b|scala|c\+\+|rust|\.net|c#|salesforce|sap|netsuite|servicenow|ios\b|swift|test|qa|sdet|support|solutions engineer|sales)\b/i;

/** Does the job sit in your stack: a stack word in the title, or (for general titles) in the description? */
export function stackFits(job: Pick<BoardJob, 'title' | 'description'>, stack: string): boolean {
  const words = stack.split(/[,\n]+/).map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (!words.length) return true;
  const title = job.title.toLowerCase();
  if (OFF_STACK.test(title) && !/react|mobile|front|full/.test(title)) return false;
  if (words.some((w) => title.includes(w))) return true;
  const desc = (job.description ?? '').toLowerCase();
  if (!desc) return /\b(software (engineer|developer)|sde|developer)\b/.test(title);
  const hits = words.filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(desc)).length;
  return hits >= 2;
}

/** Jobs from a board that fit: your titles, your level, your stack, India or open remote, posted in the last `days`. */
export function fitting(jobs: BoardJob[], o: { relevant: string[]; skipWords: string; days: number; now?: number; senior?: boolean; stack?: string }): BoardJob[] {
  const since = (o.now ?? Date.now()) - o.days * 86400_000;
  return jobs.filter(
    (j) =>
      j.url &&
      titleFits(j.title, o.relevant, o.skipWords) &&
      (o.senior !== false || !/\b(senior|sr\.?|iii|iv|l5|l6)\b/i.test(j.title)) &&
      (o.stack === undefined || stackFits(j, o.stack)) &&
      locationOk(j.location) &&
      (!j.postedAt || j.postedAt >= since),
  );
}
