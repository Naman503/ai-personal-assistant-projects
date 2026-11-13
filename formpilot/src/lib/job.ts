/**
 * Job pages and application confirmations: read the job the page is about, and
 * recognise the "your application was sent" message that sites show afterwards.
 * Content-script safe (no heavy imports).
 */

export interface JobInfo {
  url: string;
  role: string;
  company: string;
  location: string;
  source: string;
  salary: string;
  description: string;
}

export interface GivenAnswer {
  q: string;
  a: string;
}

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

const SOURCES: Record<string, string> = {
  'linkedin.com': 'LinkedIn',
  'naukri.com': 'Naukri',
  'wellfound.com': 'Wellfound',
  'instahyre.com': 'Instahyre',
  'cutshort.io': 'Cutshort',
  'indeed.com': 'Indeed',
  'hirist.tech': 'Hirist',
  'hirist.com': 'Hirist',
  'foundit.in': 'Foundit',
  'iimjobs.com': 'iimjobs',
};

export function sourceForHost(host: string): string {
  const h = host.replace(/^www\./, '');
  for (const [k, v] of Object.entries(SOURCES)) if (h === k || h.endsWith('.' + k)) return v;
  return 'Company site';
}

/** Stable URL for a job: LinkedIn job ids, otherwise the page without query or hash. */
export function canonicalJobUrl(href: string): string {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, '');
    if (host.endsWith('linkedin.com')) {
      const id = u.searchParams.get('currentJobId') || (u.pathname.match(/jobs\/view\/(\d+)/) || [])[1];
      if (id) return `https://www.linkedin.com/jobs/view/${id}/`;
    }
    return u.origin + u.pathname;
  } catch {
    return href;
  }
}

/** Read the job the page shows: JSON-LD JobPosting first, then known sites, then headings. */
export function extractJob(doc: Document = document, href = location.href): JobInfo {
  const txt = (e: Element | null | undefined) => clean((e as HTMLElement | null)?.innerText ?? e?.textContent);
  const q = (...sels: string[]) => {
    for (const s of sels) {
      try {
        const t = txt(doc.querySelector(s));
        if (t) return t;
      } catch {
        /* bad selector on this page */
      }
    }
    return '';
  };
  const qLong = (...sels: string[]) => {
    for (const s of sels) {
      try {
        const e = doc.querySelector(s) as HTMLElement | null;
        const t = String(e?.innerText ?? e?.textContent ?? '').trim();
        if (t.length > 80) return t;
      } catch {
        /* ignore */
      }
    }
    return '';
  };
  const host = new URL(href).hostname.replace(/^www\./, '');
  const job: JobInfo = { url: canonicalJobUrl(href), role: '', company: '', location: '', source: sourceForHost(host), salary: '', description: '' };

  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const d = JSON.parse(s.textContent || '');
      const items: unknown[] = Array.isArray(d) ? d : (d['@graph'] ?? [d]);
      for (const it of items as Record<string, any>[]) {
        const t = it?.['@type'];
        if (!(t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting')))) continue;
        job.role = clean(it.title) || job.role;
        const org = it.hiringOrganization;
        job.company = clean(typeof org === 'string' ? org : org?.name) || job.company;
        const loc = Array.isArray(it.jobLocation) ? it.jobLocation[0] : it.jobLocation;
        const a = loc?.address;
        if (a) job.location = [a.addressLocality, a.addressRegion].filter(Boolean).map(clean).join(', ');
        if (it.jobLocationType === 'TELECOMMUTE') job.location = job.location ? `${job.location} (remote)` : 'Remote';
        if (it.description) {
          const html = String(it.description).replace(/<(br\s*\/?|\/p|\/li|\/div|\/h\d|\/ul|\/ol)>/gi, '$&\n');
          job.description = String(new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
        }
      }
    } catch {
      /* not JSON */
    }
  }

  if (host.endsWith('linkedin.com') || doc.querySelector('[class*="jobs-unified-top-card"]')) {
    job.role = q('.job-details-jobs-unified-top-card__job-title h1', '.job-details-jobs-unified-top-card__job-title', '.jobs-unified-top-card__job-title', '.top-card-layout__title') || job.role;
    job.company = q('.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name', '.topcard__org-name-link') || job.company;
    const meta = q('.job-details-jobs-unified-top-card__primary-description-container', '.job-details-jobs-unified-top-card__tertiary-description-container', '.jobs-unified-top-card__primary-description');
    if (meta) job.location = clean(meta.split('·')[0]) || job.location;
    job.description = qLong('#job-details', '.jobs-description__content', '.jobs-box__html-content', '.description__text') || job.description;
    // Easy Apply modal: "Apply to <Company>"
    if (!job.company) job.company = clean(q('.jobs-easy-apply-modal h2, [data-test-modal] h2').replace(/^apply to\s+/i, ''));
  } else if (host.endsWith('naukri.com')) {
    job.role = q('h1[class*="jd-header-title"]', 'h1') || job.role;
    job.company = q('[class*="jd-header-comp-name"] a', '[class*="jd-header-comp-name"]') || job.company;
    job.location = q('[class*="location"] a', '[class*="loc"] a') || job.location;
    job.salary = q('[class*="salary"]') || job.salary;
    job.description = qLong('[class*="job-desc"]', '[class*="dang-inner-html"]') || job.description;
  }
  if (!job.role) job.role = q('h1') || clean(doc.title.split(/\s[|\-–]\s/)[0]);
  if (!job.company) job.company = clean((doc.querySelector('meta[property="og:site_name"]') as HTMLMetaElement | null)?.content);
  if (!job.description) job.description = qLong('main', 'article', '[class*="description"]');
  job.description = job.description.slice(0, 15000);
  job.role = job.role.slice(0, 200);
  job.company = job.company.replace(/\s*\|.*$/, '').slice(0, 120);
  job.location = job.location.slice(0, 120);
  return job;
}

/** Messages sites show once an application has gone through. */
export const CONFIRMATION_RE =
  /\b(your application (was|has been) (sent|submitted|received)|application (sent|submitted|received)( successfully)?|successfully applied|you('ve| have) (successfully )?applied|applied successfully|thank(s| you) for (applying|your application|submitting your application)|we('ve| have) received your application|your application is (on its way|in))\b/i;

/** Pages a site redirects to after an application. */
export const CONFIRMATION_URL_RE = /\/(thank-?you|thanks|confirmation|application-?(submitted|confirmation|success)|applied|success)(\/|$|\?)/i;

/** Clicks that may send an application (not ones that only open the form). */
export function looksLikeSubmit(text: string): boolean {
  const t = clean(text).toLowerCase();
  if (!t || t.length > 40) return false;
  if (/^(easy apply|apply now|apply on company (site|website)|apply externally|i'?m interested|save|filter|apply filters?|sign in|log ?in)$/.test(t)) {
    // Naukri's "Apply" button sends the application in one click, so plain "apply" counts.
    return false;
  }
  return /\b(submit|send application|send|apply|finish|complete application|done)\b/.test(t);
}

/** LinkedIn's job page label once you have applied ("Applied 0 minutes ago", "Applied now"). */
export const APPLIED_LABEL_RE = /\bapplied (now|just now|(a|an|\d+) (seconds?|minutes?) ago)\b/i;

export function isConfirmation(text: string): boolean {
  const t = clean(text);
  return CONFIRMATION_RE.test(t) || APPLIED_LABEL_RE.test(t);
}

/** How many confirmation phrases a text holds (used to spot a new one appearing). */
export function confirmationCount(text: string): number {
  const t = clean(text);
  const g = (re: RegExp) => (t.match(new RegExp(re.source, 'gi')) ?? []).length;
  return g(CONFIRMATION_RE) + g(APPLIED_LABEL_RE);
}

/**
 * All text on the page, including inside open shadow roots and same-origin iframes.
 * LinkedIn's Easy Apply dialog lives in a shadow root, which body.innerText never sees.
 */
export function deepText(root: Document | ShadowRoot = document, max = 400_000): string {
  let out = root instanceof Document ? (root.body?.innerText ?? '') : (root.textContent ?? '');
  // A content script's `el.shadowRoot` is null for roots the page attached; chrome.dom can see them.
  const domApi = (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?: (e: HTMLElement) => ShadowRoot | null } } }).chrome?.dom;
  const shadowOf = (el: HTMLElement): ShadowRoot | null => {
    try {
      return domApi?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
    } catch {
      return el.shadowRoot;
    }
  };
  // textContent runs block elements together ("Application sentYour application…"), so join text nodes with spaces.
  const textOf = (r: ShadowRoot) => {
    const parts: string[] = [];
    const w = (r.ownerDocument ?? document).createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const tag = n.parentElement?.tagName;
      if (tag !== 'SCRIPT' && tag !== 'STYLE' && n.nodeValue?.trim()) parts.push(n.nodeValue.trim());
    }
    return parts.join(' ');
  };
  const walk = (r: Document | ShadowRoot) => {
    for (const el of r.querySelectorAll('*')) {
      if (out.length > max) return;
      const sr = shadowOf(el as HTMLElement);
      if (sr) {
        out += '\n' + textOf(sr);
        walk(sr);
      }
    }
  };
  walk(root);
  return out;
}
