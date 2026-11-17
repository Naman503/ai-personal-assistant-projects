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

export type Platform = 'linkedin' | 'naukri' | 'foundit' | 'cutshort';
export const PLATFORMS: Platform[] = ['linkedin', 'naukri', 'foundit', 'cutshort'];
export const PLATFORM_NAME: Record<Platform, string> = { linkedin: 'LinkedIn', naukri: 'Naukri', foundit: 'Foundit', cutshort: 'Cutshort' };

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
  return p === 'naukri' ? naukriJobs(doc) : p === 'cutshort' ? cutshortJobs(doc) : p === 'foundit' ? founditJobs(doc) : [];
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
  // Cutshort's job page says "Apply to this job". Its "Apply now" buttons belong to the similar
  // jobs listed further down: never press those (found on the first live dry run).
  const apply = buttonByText(/^(apply to this job|apply for this job|apply)$/i, doc);
  return { apply, applied: !apply && !!buttonByText(/^(applied|application sent)$/i, doc), external: false };
}

/** The site says the application went through. */
export function sentNotice(p: Platform, doc: Document = document, href = location.href): boolean {
  if (p === 'naukri' && /\/myapply\/(saveApply|)/i.test(href)) return true;
  const t = (doc.body?.innerText ?? '').slice(0, 30000);
  if (/(successfully applied|applied successfully|application (was )?(sent|submitted)|you have applied|your application has been (sent|submitted))/i.test(t)) return true;
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
