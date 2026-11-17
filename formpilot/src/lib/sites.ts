/**
 * Naukri and Cutshort for the autopilot: search links, reading the job list, and the signs on a
 * job page (Apply button, already applied, external apply, sent, pushback). Markup read live on
 * 2026-11-16:
 *  - Naukri search: .srp-jobtuple-wrapper[data-job-id] › a.title (href = job page),
 *    a.comp-name, .expwdth ("4-6 Yrs"), .locWdth. Job page: button#apply-button "Apply"; jobs
 *    that apply on the company's site show "Apply on company site" instead. Applying may open a
 *    recruiter chatbot drawer (.chatbot_Drawer) asking one question at a time.
 *  - Cutshort search: cards with h3 › a[href*="/job/"], "at <a>Company</a>", "1 - 3 yrs",
 *    and a button "Apply now".
 *  - Foundit (read live 2026-11-17, signed in): search foundit.in/srp/results?query=…; cards
 *    div.cardContainer[id=<job id>] › #jobCardTitle, .companyName, .details ("5 - 10 Years"),
 *    .details.location, a "Quick Apply" tag (.cardApplyLabel) and a tick box on Quick Apply jobs.
 *    Job page foundit.in/job/<id>: the real button is #jdPageHeader #applyBtn, "Quick Apply"
 *    (applies on Foundit) or "Apply Now" (the job comes from elsewhere: LinkedIn, the company's
 *    site). The other #applyBtn buttons on that page belong to similar jobs: never press those.
 */

import { isVisible } from './fields/context';
import { locationOk } from './sitepilot/boards';

export type Platform = 'linkedin' | 'naukri' | 'foundit' | 'cutshort' | 'instahyre' | 'hirist' | 'uplers' | 'wellfound' | 'yc';
export const PLATFORMS: Platform[] = ['linkedin', 'naukri', 'foundit', 'cutshort', 'instahyre', 'hirist', 'uplers', 'wellfound', 'yc'];
export const PLATFORM_NAME: Record<Platform, string> = {
  linkedin: 'LinkedIn',
  naukri: 'Naukri',
  foundit: 'Foundit',
  cutshort: 'Cutshort',
  instahyre: 'Instahyre',
  hirist: 'Hirist',
  uplers: 'Uplers',
  wellfound: 'Wellfound',
  yc: 'YC Work at a Startup',
};
/** Portals whose list already comes from your profile / saved search: the title isn't used. */
export const ONE_LIST: Platform[] = ['instahyre', 'uplers', 'wellfound', 'yc'];

export interface SiteJob {
  url: string;
  title: string;
  company: string;
  /** Minimum years asked ("4-6 Yrs" → 4), when the list shows it. */
  expMin?: number;
  location?: string;
  applied?: boolean;
  /** Foundit: applies on the site in one go ("Quick Apply"); the others apply elsewhere. */
  quick?: boolean;
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export function platformOf(href: string): Platform | null {
  const h = (() => {
    try {
      return new URL(href).hostname;
    } catch {
      return '';
    }
  })();
  if (h.endsWith('linkedin.com')) return 'linkedin';
  if (h.endsWith('naukri.com')) return 'naukri';
  if (h.endsWith('cutshort.io')) return 'cutshort';
  if (h.endsWith('foundit.in')) return 'foundit';
  if (h.endsWith('instahyre.com')) return 'instahyre';
  if (h.endsWith('hirist.tech')) return 'hirist';
  if (h.endsWith('uplers.com')) return 'uplers';
  if (h.endsWith('wellfound.com')) return 'wellfound';
  if (h.endsWith('workatastartup.com')) return 'yc';
  return null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Naukri search: newest within `days`, matching ~your experience (3 years). */
export function naukriSearchUrl(title: string, days: number, years = 3): string {
  const p = new URLSearchParams({ k: title, jobAge: String(Math.max(1, Math.min(30, days))), experience: String(years) });
  return `https://www.naukri.com/${slug(title)}-jobs?${p}`;
}

/** Foundit search across India. */
export function founditSearchUrl(title: string): string {
  return `https://www.foundit.in/srp/results?${new URLSearchParams({ query: title, locations: 'India' })}`;
}

export function cutshortSearchUrl(title: string): string {
  return `https://cutshort.io/search-jobs?${new URLSearchParams({ free_text: title })}`;
}

/** "4-6 Yrs", "1 - 3 yrs", "5+ years" → 4, 1, 5. */
export function expMinOf(text: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*(?:-|–|to|\+)?\s*(?:\d+(?:\.\d+)?)?\s*(?:yrs?|years?)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

export function naukriJobs(doc: ParentNode = document): SiteJob[] {
  return [...doc.querySelectorAll<HTMLElement>('.srp-jobtuple-wrapper, article.jobTuple')].flatMap((c) => {
    const a = c.querySelector<HTMLAnchorElement>('a.title, a[class*="title"]');
    if (!a?.href) return [];
    const exp = clean(c.querySelector('.expwdth, [class*="exp"] span[title]')?.textContent);
    return [
      {
        url: a.href.replace(/[?&](src|sid|xp|px|nignbevent_src)=[^&]*/g, ''),
        title: clean(a.getAttribute('title') || a.textContent),
        company: clean(c.querySelector('a.comp-name, [class*="comp-name"]')?.textContent),
        expMin: expMinOf(exp),
        location: clean(c.querySelector('.locWdth, [class*="locWdth"]')?.textContent),
        applied: /\bapplied\b/i.test(clean(c.querySelector('.row6, [class*="applied"]')?.textContent)),
      },
    ];
  });
}

export function cutshortJobs(doc: ParentNode = document): SiteJob[] {
  const seen = new Set<string>();
  return [...doc.querySelectorAll<HTMLAnchorElement>('h3 a[href*="job"], h2 a[href*="job"]')].flatMap((a) => {
    const url = a.href;
    if (seen.has(url)) return [];
    seen.add(url);
    // The card: the nearest ancestor that also holds the "Apply" button or the experience line.
    let card: HTMLElement | null = a.parentElement;
    for (let i = 0; i < 8 && card && !/\byrs?\b|apply now|applied/i.test(card.innerText || card.textContent || ''); i++) card = card.parentElement;
    const text = clean(card?.innerText || card?.textContent);
    const at = card?.querySelector<HTMLAnchorElement>('a[href*="/company/"]');
    return [{ url, title: clean(a.textContent), company: clean(at?.textContent), expMin: expMinOf(text), applied: /\bapplied\b/i.test(text) && !/apply now/i.test(text) }];
  });
}

export function founditJobs(doc: ParentNode = document): SiteJob[] {
  return [...doc.querySelectorAll<HTMLElement>('div.cardContainer[id]')].flatMap((c) => {
    const id = c.id.trim();
    const title = clean(c.querySelector('#jobCardTitle, .jobTitle')?.textContent);
    if (!/^\d+$/.test(id) || !title) return [];
    const text = clean(c.innerText || c.textContent);
    return [
      {
        // foundit.in/job/<id> opens the job page (test pages: foundit-job.html?id=<id> next to the list).
        url: typeof location !== 'undefined' && !/(^|\.)foundit\.in$/.test(location.hostname) ? `${location.origin}/foundit-job.html?id=${id}` : `https://www.foundit.in/job/${id}`,
        title,
        company: clean(c.querySelector('.companyName')?.textContent),
        expMin: expMinOf(clean(c.querySelector('.experienceSalary .details, .details')?.textContent)),
        location: clean(c.querySelector('.details.location')?.textContent),
        applied: /\bapplied\b/i.test(text) && !/quick apply|apply now/i.test(clean(c.querySelector('.jobTags')?.textContent)),
        quick: /quick apply/i.test(clean(c.querySelector('.cardApplyLabel, .jobTags')?.textContent)) || !!c.querySelector('input#quick-apply-check'),
      },
    ];
  });
}

export function siteJobs(p: Platform, doc: ParentNode = document): SiteJob[] {
  switch (p) {
    case 'naukri':
      return naukriJobs(doc);
    case 'cutshort':
      return cutshortJobs(doc);
    case 'foundit':
      return founditJobs(doc);
    case 'instahyre':
      return instahyreJobs(doc);
    case 'hirist':
      return hiristJobs(doc);
    case 'uplers':
      return uplersJobs(doc);
    case 'wellfound':
      return wellfoundJobs(doc);
    case 'yc':
      return ycJobs(doc);
    default:
      return [];
  }
}

/** A button or link whose own text is exactly one of these (case-insensitive). */
export function buttonByText(re: RegExp, root: ParentNode = document): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>('button, a[role=button], [role=button]')].find((b) => {
      const t = clean(b.innerText || b.textContent);
      return re.test(t) && !(b as HTMLButtonElement).disabled && isVisible(b);
    }) ?? null
  );
}

/** On a job page: can it be applied to here, is it done already, or does it go elsewhere? */
export function jobPageState(p: Platform, doc: Document = document): { apply: HTMLElement | null; applied: boolean; external: boolean } {
  if (p === 'naukri') {
    const apply = doc.querySelector<HTMLElement>('button#apply-button');
    const label = clean(apply?.textContent);
    const external = !apply && !!buttonByText(/apply on company site/i, doc);
    return { apply: apply && /^apply$/i.test(label) ? apply : null, applied: /^applied$/i.test(label) || /you have (already )?applied/i.test(doc.body?.innerText ?? ''), external };
  }
  if (p === 'foundit') {
    const btn = doc.querySelector<HTMLElement>('#jdPageHeader #applyBtn, .jobMainInfoCard #applyBtn');
    const label = clean(btn?.textContent);
    const quick = !!btn && /^quick apply$/i.test(label) && !(btn as HTMLButtonElement).disabled;
    return { apply: quick ? btn : null, applied: /^applied$/i.test(label), external: !!btn && /^apply( now)?$/i.test(label) };
  }
  if (p === 'instahyre' || p === 'hirist' || p === 'uplers' || p === 'wellfound' || p === 'yc') return remotePageState(p, doc);
  // Cutshort's job page says "Apply to this job". Its "Apply now" buttons belong to the similar
  // jobs listed further down: never press those (found on the first live dry run).
  const apply = buttonByText(/^(apply to this job|apply for this job|apply)$/i, doc);
  return { apply, applied: !apply && !!buttonByText(/^(applied|application sent)$/i, doc), external: false };
}

/** The site says the application went through. */
export function sentNotice(p: Platform, doc: Document = document, href = location.href): boolean {
  if (p === 'naukri' && /\/myapply\/(saveApply|)/i.test(href)) return true;
  const t = (doc.body?.innerText ?? '').slice(0, 30000);
  if (/(successfully applied|applied successfully|application (was )?(sent|submitted)|you have applied|your application has been (sent|submitted)|message sent|you applied|application received)/i.test(t)) return true;
  // Foundit: Quick Apply lands on foundit.in/srp/applied-success?id=<job> (seen 17 Nov), or the
  // header button turns into "Applied".
  if (p === 'foundit') return /\/srp\/applied-success/i.test(href) || /^applied$/i.test(clean(doc.querySelector('#jdPageHeader #applyBtn, .jobMainInfoCard #applyBtn')?.textContent));
  return p === 'naukri' ? /^applied$/i.test(clean(doc.querySelector('button#apply-button')?.textContent)) : !!buttonByText(/^applied$/i, doc);
}

/** Login walls, captchas and limits: stop the platform for the day. */
export function sitePushback(p: Platform, doc: Document = document, href = location.href): string {
  if (p === 'naukri' && /naukri\.com\/(nlogin|login)/.test(href)) return 'Naukri wants you to sign in';
  if (p === 'cutshort' && /cutshort\.io\/(login|signin|signup)/.test(href)) return 'Cutshort wants you to sign in';
  if (p === 'foundit' && /foundit\.in\/(rio\/)?(login|signin|register)/.test(href)) return 'Foundit wants you to sign in';
  if (p === 'instahyre' && /instahyre\.com\/(login|signup)/.test(href)) return 'Instahyre wants you to sign in';
  if (p === 'hirist' && /hirist\.tech\/(login|signup|register)/.test(href)) return 'Hirist wants you to sign in';
  if (p === 'uplers' && /uplers\.com\/talent\/(login|joinus|signin)/.test(href)) return 'Uplers wants you to sign in';
  if (p === 'wellfound' && /wellfound\.com\/(login|join)/.test(href)) return 'Wellfound wants you to sign in';
  if (p === 'yc' && /(account\.ycombinator\.com|workatastartup\.com\/(signin|login|users\/sign_in))/.test(href)) return 'YC Work at a Startup wants you to sign in';
  const t = (doc.body?.innerText ?? '').slice(0, 20000);
  const m = t.match(/(daily (apply|application) limit|reached (the|your) (daily )?limit|too many (requests|applications)|verify (that )?you are (a )?human|captcha|unusual activity|access denied)/i);
  return m ? `${PLATFORM_NAME[p]} says: "${m[0]}"` : '';
}

// ------------------------------------------------------------------ Naukri "Recommended jobs"

/**
 * naukri.com/mnjuser/recommendedjobs (read live 2026-11-16): tabs "Applies (66)", "Handpicked
 * for you", "Profile", "You might like"; cards article.jobTuple[data-job-id] with a checkbox
 * input.tuple-check-input ("Select <title> for apply"), a.jt-title-link, the company in
 * .subTitle, li.experience. Only jobs that apply on Naukri get a checkbox. Up to 5 can be
 * ticked, then one button.multi-apply-button "Apply" applies to all of them.
 */
export const NAUKRI_REC_URL = 'https://www.naukri.com/mnjuser/recommendedjobs';
export const NAUKRI_REC_TABS = [/^applies\b/i, /^handpicked/i, /^you might like/i, /^profile\b/i];

export interface RecJob extends SiteJob {
  id: string;
  box: HTMLInputElement;
}

export function naukriRecJobs(doc: ParentNode = document): RecJob[] {
  return [...doc.querySelectorAll<HTMLElement>('article.jobTuple[data-job-id], article[data-job-id]')].flatMap((c) => {
    const box = c.querySelector<HTMLInputElement>('input.tuple-check-input, input[type=checkbox]');
    const a = c.querySelector<HTMLAnchorElement>('a.jt-title-link, a[data-tuple-title], p.title a');
    if (!box || !a) return [];
    const exp = clean(c.querySelector('li.experience span, .experience span')?.textContent);
    return [
      {
        id: c.getAttribute('data-job-id') ?? '',
        url: a.href,
        title: clean(a.getAttribute('title') || a.textContent),
        company: clean(c.querySelector('.subTitle, [class*="companyInfo"] [title]')?.textContent),
        expMin: expMinOf(exp),
        location: clean(c.querySelector('li.location span')?.textContent),
        box,
      },
    ];
  });
}

/** The "Apply" button for the ticked jobs. */
export const naukriMultiApply = (doc: ParentNode = document) => doc.querySelector<HTMLButtonElement>('button.multi-apply-button');

/** After a multi-apply Naukri lands on /myapply/saveApply?…&multiApplyResp={"<jobId>":200,…}. */
export function multiApplyResult(href: string): Record<string, number> | null {
  try {
    const raw = new URL(href).searchParams.get('multiApplyResp');
    return raw ? (JSON.parse(raw) as Record<string, number>) : null;
  } catch {
    return null;
  }
}

/** Same job listed twice (different links): company + title is the key. */
export const jobKey = (j: Pick<SiteJob, 'company' | 'title'>) => `${clean(j.company).toLowerCase()}|${clean(j.title).toLowerCase()}`;

// ------------------------------------------------------------------ Remote and India-remote portals

/**
 * Five portals added for remote jobs (markup read live 2026-11-17, signed in, nothing submitted):
 *  - Instahyre candidate/opportunities/?matching=true: rows .employer-row; h2.company-name
 *    "<Company> - <Role>"; .chip-location; ul#job-skills-<jobId>; buttons "View job »"
 *    (.btn-interested, opens the job in a pop-up with its apply button) and "Not interested".
 *    A job's "page" is that list with #opp-<jobId>: the pop-up is opened from the row.
 *  - Hirist search hirist.tech/search/<words>?minexp=2&maxexp=4: a[href*="/j/"] cards with
 *    [data-testid=job_title] "<Company> - <Role>", job_experience "2 - 4 yrs", job_location.
 *    Job page: a one-click "Apply" (iimjobs style), sometimes recruiter questions after it.
 *  - Uplers platform.uplers.com/talent/all-opportunities: .jobCardContainer › h6 (title),
 *    .companyName, ul.jobAttribs li ("2 - 4 Years Exp", "Remote" / "Onsite - Bengaluru"), the
 *    job id in #skills_<id>. Picking a card shows it on the right (?activeJob=<id>) with
 *    button[id$=singleOppAppyBtn] "APPLY NOW".
 *  - Wellfound /jobs (your saved search: roles, India/Asia, remote): [data-test=StartupResult]
 *    per company (h2 = name), each job a[class*=jobLink] /jobs/<id> with span[class*=title],
 *    span[class*=location], span[class*=compensation]; a badge "Apply on Wellfound" (or "on the
 *    company's site"). Job page: "Apply" opens a dialog: a note box ("What interests you about
 *    working for this company?", sometimes customQuestionAnswers[<id>][answer]) and "Send
 *    application".
 *  - YC workatastartup.com/companies?role=eng: job links a[href^="/jobs/<id>"] with a details line
 *    "<locations> · Fulltime · US Citizenship/Visa Not Required · $80K - $150K · 3+ Years"; the
 *    company is the a[href^="/companies/<slug>"] above them. Job page: "Apply" opens "Reach out to
 *    <founder>": textarea#apply-message (50+ characters), a pre-ticked
 *    #apply-open-to-relocation box, and "Send".
 */

export function instahyreSearchUrl(): string {
  return 'https://www.instahyre.com/candidate/opportunities/?matching=true';
}
export function hiristSearchUrl(title: string): string {
  return `https://www.hirist.tech/search/${slug(title)}?minexp=2&maxexp=4`;
}
export function uplersSearchUrl(): string {
  return 'https://platform.uplers.com/talent/all-opportunities';
}
export function wellfoundSearchUrl(): string {
  return 'https://wellfound.com/jobs';
}
/** YC's remote software engineering jobs (30 newest, with locations; read live 18 Nov). */
export function ycSearchUrl(): string {
  return 'https://www.workatastartup.com/jobs/r/software-engineer';
}

/** The list page for a portal and title. */
export function searchUrlFor(p: Platform, title: string): string {
  switch (p) {
    case 'instahyre':
      return instahyreSearchUrl();
    case 'hirist':
      return hiristSearchUrl(title);
    case 'uplers':
      return uplersSearchUrl();
    case 'wellfound':
      return wellfoundSearchUrl();
    case 'yc':
      return ycSearchUrl();
    default:
      return '';
  }
}

/** "Kutumb - Android Engineer" → company + role. */
function splitCompanyRole(s: string): { company: string; title: string } {
  const m = /^(.{2,60}?)\s+[-–]\s+(.+)$/.exec(clean(s));
  return m ? { company: m[1], title: m[2] } : { company: '', title: clean(s) };
}

export function instahyreJobs(doc: ParentNode = document): SiteJob[] {
  const base = typeof location !== 'undefined' ? location.href.split('#')[0] : instahyreSearchUrl();
  return [...doc.querySelectorAll<HTMLElement>('.employer-row')].flatMap((r) => {
    const id = r.querySelector('[id^="job-skills-"]')?.id.replace('job-skills-', '') ?? '';
    const head = clean(r.querySelector('h2.company-name, .employer-job-name')?.textContent);
    if (!id || !head) return [];
    const { company, title } = splitCompanyRole(head);
    return [{ url: `${base}#opp-${id}`, title, company, location: clean(r.querySelector('.chip-location')?.textContent) }];
  });
}

export function hiristJobs(doc: ParentNode = document): SiteJob[] {
  const seen = new Set<string>();
  return [...doc.querySelectorAll<HTMLAnchorElement>('a[href*="/j/"]')].flatMap((a) => {
    const t = clean(a.querySelector('[data-testid=job_title]')?.textContent);
    const url = a.href.split('?')[0];
    if (!t || seen.has(url)) return [];
    seen.add(url);
    const { company, title } = splitCompanyRole(t);
    return [{ url, title, company, expMin: expMinOf(clean(a.querySelector('[data-testid=job_experience]')?.textContent)), location: clean(a.querySelector('[data-testid=job_location]')?.textContent) }];
  });
}

export function uplersJobs(doc: ParentNode = document): SiteJob[] {
  const base = typeof location !== 'undefined' && /uplers/.test(location.hostname) ? `${location.origin}${location.pathname}` : uplersSearchUrl();
  return [...doc.querySelectorAll<HTMLElement>('.jobCardContainer')].flatMap((c) => {
    const id = (c.querySelector('[id^="skills_"]')?.id ?? c.querySelector('[id^="partner"]')?.id ?? '').replace(/^(skills_|partner)/, '');
    const title = clean(c.querySelector('h6, .jobTitle .main > :first-child')?.textContent);
    if (!id || !title) return [];
    const attrs = [...c.querySelectorAll('ul.jobAttribs li')].map((li) => clean(li.textContent));
    return [{ url: `${base}?activeJob=${encodeURIComponent(id)}`, title, company: clean(c.querySelector('.companyName')?.textContent), expMin: expMinOf(attrs.find((a) => /exp/i.test(a)) ?? ''), location: attrs.find((a) => /remote|onsite|hybrid|office/i.test(a)) ?? '' }];
  });
}

export function wellfoundJobs(doc: ParentNode = document): SiteJob[] {
  return [...doc.querySelectorAll<HTMLElement>('[data-test=StartupResult]')].flatMap((c) => {
    const company = clean(c.querySelector('a[href^="/company/"] h2, h2')?.textContent);
    return [...c.querySelectorAll<HTMLAnchorElement>('a[class*="jobLink"], a[href^="/jobs/"]')].flatMap((a) => {
      if (!/\/jobs\/\d+/.test(a.getAttribute('href') ?? '')) return [];
      const row = a.closest('div')?.parentElement ?? a;
      const badge = clean(row.querySelector('[class*="badge"]')?.textContent);
      const loc = clean(a.querySelector('[class*="location"]')?.parentElement?.textContent ?? a.querySelector('[class*="location"]')?.textContent);
      return [
        {
          url: a.href.split('?')[0],
          title: clean(a.querySelector('[class*="title"]')?.textContent) || clean(a.textContent).slice(0, 80),
          company,
          location: loc,
          // "Apply on Wellfound": the application goes through Wellfound. Others send you to the company.
          quick: !badge || /wellfound/i.test(badge),
        },
      ];
    });
  });
}

/**
 * workatastartup.com/jobs/r/software-engineer (read live 18 Nov): per job a[target=company]
 * ("Instawork (S15) • …"), a[target=job] /jobs/<id> (title) and a <p> with spans "Full-time",
 * "Bengaluru, KA, IN / …", "Full stack".
 */
function ycRoleJobs(doc: ParentNode): SiteJob[] {
  const seen = new Set<string>();
  return [...doc.querySelectorAll<HTMLAnchorElement>('a[target=job][href*="/jobs/"]')].flatMap((a) => {
    if (!/\/jobs\/\d+$/.test(a.getAttribute('href') ?? '') || seen.has(a.href)) return [];
    seen.add(a.href);
    let c: HTMLElement | null = a.parentElement;
    while (c && !c.querySelector('a[target=company]')) c = c.parentElement;
    const co = clean(c?.querySelector('a[target=company] span span')?.textContent ?? c?.querySelector('a[target=company]')?.textContent).replace(/\s*\([A-Z]\d{2}\)\s*$/, '');
    const spans = [...(a.parentElement?.nextElementSibling?.querySelectorAll('span') ?? [])].map((x) => clean(x.textContent));
    return [{ url: a.href, title: clean(a.textContent), company: co, location: spans[1] ?? '' }];
  });
}

export function ycJobs(doc: ParentNode = document): SiteJob[] {
  if (doc.querySelector('a[target=job][href*="/jobs/"]')) return ycRoleJobs(doc);
  const seen = new Set<string>();
  return [...doc.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/"]')].flatMap((a) => {
    if (!/\/jobs\/\d+$/.test(a.getAttribute('href') ?? '') || a.getAttribute('aria-label') || seen.has(a.href)) return [];
    const title = clean(a.textContent);
    if (!title || /^view job$/i.test(title)) return [];
    seen.add(a.href);
    let c: HTMLElement | null = a.parentElement;
    while (c && !c.querySelector('a[href*="/companies/"]')) c = c.parentElement;
    const company = clean([...(c?.querySelectorAll<HTMLAnchorElement>('a[href*="/companies/"]') ?? [])].map((x) => clean(x.textContent)).find((t) => t && !/website/i.test(t)));
    const meta = clean((a.parentElement?.nextElementSibling as HTMLElement | null)?.textContent);
    const parts = meta.split('·').map(clean);
    return [{ url: a.href, title, company, location: meta, expMin: expMinOf(parts.find((x) => /year/i.test(x)) ?? ''), quick: /visa not required/i.test(meta) || !/sponsor|us citizen/i.test(meta) || /remote/i.test(parts[0] ?? '') }];
  });
}

/**
 * Can someone in India take this job? India (any city), or remote that isn't tied to another
 * country. YC: a "Remote" job that says "US Citizenship/Visa Not Required" counts too.
 */
export function openToIndia(p: Platform, j: Pick<SiteJob, 'location'>): boolean {
  const loc = clean(j.location);
  if (!loc) return true;
  if (p === 'yc') {
    const where = loc.split('·')[0] ?? '';
    if (/\b(india|bengaluru|bangalore|remote \(?(in|india|apac|asia)|anywhere|worldwide)\b/i.test(where)) return true;
    if (/visa not required/i.test(loc)) return /\bremote\b/i.test(where) && !/remote \((us|ca|uk|eu)\b/i.test(where);
    return locationOk(where.replace(/\s*\/\s*/g, ' · '));
  }
  if (p === 'wellfound') return /india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|gurugram|gurgaon|noida|chennai|indore|remote/i.test(loc);
  if (p === 'uplers' || p === 'hirist' || p === 'instahyre') return true; // India portals
  return locationOk(loc);
}

function remotePageState(p: Platform, doc: Document): { apply: HTMLElement | null; applied: boolean; external: boolean } {
  switch (p) {
    case 'uplers': {
      const b = doc.querySelector<HTMLElement>('button[id$="singleOppAppyBtn"]');
      const label = clean(b?.textContent);
      return { apply: b && /^apply now$/i.test(label) && !(b as HTMLButtonElement).disabled ? b : null, applied: /^applied$/i.test(label) || !!buttonByText(/^applied$/i, doc), external: false };
    }
    case 'hirist': {
      const apply = buttonByText(/^apply$/i, doc);
      return { apply, applied: !apply && !!buttonByText(/^applied$/i, doc), external: !apply && !!buttonByText(/^apply on company (site|website)$/i, doc) };
    }
    case 'wellfound': {
      const apply = buttonByText(/^apply$/i, doc) ?? buttonByText(/^apply now$/i, doc);
      const t = clean(doc.body?.innerText).slice(0, 20000);
      return { apply, applied: !apply && (!!buttonByText(/^applied$/i, doc) || /you applied|application sent/i.test(t)), external: !apply && /apply on (the )?company('s)? (site|website)/i.test(t) };
    }
    case 'yc': {
      const apply = buttonByText(/^apply$/i, doc);
      return { apply, applied: !apply && !!buttonByText(/^(applied|message sent|reached out)$/i, doc), external: false };
    }
    case 'instahyre': {
      const id = /#opp-(\d+)/.exec(typeof location !== 'undefined' ? location.hash : '')?.[1] ?? '';
      const row = id ? (doc.getElementById(`job-skills-${id}`)?.closest<HTMLElement>('.employer-row') ?? null) : null;
      const view = row?.querySelector<HTMLElement>('.btn-interested') ?? null;
      return { apply: view, applied: !!row && !view && /applied|interested/i.test(clean(row.innerText)), external: false };
    }
    default:
      return { apply: null, applied: false, external: false };
  }
}
