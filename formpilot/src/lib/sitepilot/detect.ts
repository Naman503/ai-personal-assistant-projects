/**
 * Site Pilot: recognise the application system, pages that need you, closed jobs, consent and
 * demographic questions. Pure functions over text and URLs (unit-tested), no DOM.
 */

export const ATS = ['google-forms', 'greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'zoho', 'keka', 'darwinbox', 'freshteam', 'other'] as const;
export type Ats = (typeof ATS)[number];

export const ATS_NAME: Record<Ats, string> = {
  'google-forms': 'Google Forms',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  smartrecruiters: 'SmartRecruiters',
  zoho: 'Zoho Recruit',
  keka: 'Keka',
  darwinbox: 'Darwinbox',
  freshteam: 'Freshteam',
  other: 'Other sites',
};

/** Systems that need an account before you can apply: always left for you. */
const ACCOUNT_HOSTS = /(myworkdayjobs\.com|workday\.com|taleo\.net|successfactors\.(com|eu)|sapsf\.(com|eu)|icims\.com|brassring\.com|oraclecloud\.com\/hcmUI|jobvite\.com\/.*\/login|ultipro\.com|adp\.com|phenompeople|eightfold\.ai)/i;

/** Which system runs this page, from its URL and (optionally) its HTML. */
export function detectAts(url: string, html = ''): Ats {
  const u = url.toLowerCase();
  if (/docs\.google\.com\/forms|forms\.gle\//.test(u)) return 'google-forms';
  if (/greenhouse\.io/.test(u) || /grnhse_(app|iframe)|boards\.greenhouse\.io|job-boards\.greenhouse\.io/.test(html)) return 'greenhouse';
  if (/jobs\.lever\.co|lever\.co\//.test(u)) return 'lever';
  if (/ashbyhq\.com/.test(u) || /ashby_embed|jobs\.ashbyhq\.com/.test(html)) return 'ashby';
  if (/workable\.com/.test(u)) return 'workable';
  if (/smartrecruiters\.com/.test(u)) return 'smartrecruiters';
  if (/zohorecruit\.|recruit\.zoho\./.test(u)) return 'zoho';
  if (/keka\.com/.test(u)) return 'keka';
  if (/darwinbox\.(in|com)/.test(u)) return 'darwinbox';
  if (/freshteam\.com/.test(u)) return 'freshteam';
  return 'other';
}

export function needsAccount(url: string): boolean {
  return ACCOUNT_HOSTS.test(url);
}

/** The job is no longer open. */
export const CLOSED_RE =
  /\b(no longer (accepting applications|available|open|active)|(this )?(job|position|role|posting|opening) (has been|is) (closed|filled|expired|removed)|job (has )?expired|applications? (are|is) (now )?closed|position (has been )?filled|the job you are looking for (is no longer|does not exist)|page (you requested (was|could) not|not found))\b/i;

/** Pages that ask for something only you can do: sign in, a test, a payment, an OTP. */
export function blockerIn(text: string): string | null {
  const t = text.replace(/\s+/g, ' ');
  if (/\b(sign in|log ?in) (to|with) (apply|continue|your account)|create (an|your) account to (apply|continue)|please (sign|log) ?in\b/i.test(t)) return 'asks you to sign in or create an account';
  if (/\b(online (test|assessment)|coding (test|challenge|assessment)|take (the|this) (test|assessment|quiz)|hackerrank|codility|hackerearth|mettl|testgorilla)\b/i.test(t) && !/after (you apply|applying)|later stage|shortlisted/i.test(t)) return 'asks you to take a test';
  if (/\b(enter (the )?otp|one[- ]time (password|code)|verification code (has been )?sent)\b/i.test(t)) return 'asks for a verification code';
  if (/\b(registration fee|pay (now|₹|rs\.?|inr)|payment (gateway|required))\b/i.test(t)) return 'asks for a payment';
  return null;
}

/** Buttons that open the application form from a job description page. */
export const OPEN_FORM_RE = /^(apply( now| for this (job|position|role)| to (this )?job| here| online)?|i'?m interested|start (your )?application|apply with (your )?(resume|cv))$/i;

/** Consent boxes that are fine to tick for you (required to apply). */
export const CONSENT_RE = /\b(privacy (policy|notice|statement)|terms (and|&) conditions|terms of (use|service)|consent to (the )?(processing|collection|storage)|process(ing)? (of )?my (personal )?(data|information)|data protection|gdpr|i (hereby )?(agree|acknowledge|confirm|certify|declare)|information (provided )?is (true|accurate|correct))\b/i;

/** Boxes never ticked for you: newsletters, marketing, talent communities, messages. */
export const MARKETING_RE = /\b(newsletter|marketing|promotional|offers|updates? (about|on) (future|new|other)|future (job )?opportunities|talent (community|pool|network)|job alerts?|sms|whatsapp|text messages?|subscribe|keep me informed|contact me about)\b/i;

/** Opt-in questions asked as Yes/No (stay up to date, job alerts): always No. */
export const OPT_IN_RE = /\b(stay up to date|keep (me )?(informed|updated|in touch)|(job )?alerts?( for similar)?|newsletter|marketing (emails?|communications?)|future (job )?(opportunities|openings|roles)|talent (community|pool|network)|subscribe|contact me about other)\b/i;

export function consentToTick(label: string, required: boolean): boolean {
  if (MARKETING_RE.test(label)) return false;
  return CONSENT_RE.test(label) && (required || /\*\s*$/.test(label.trim()) || /\b(required|mandatory)\b/i.test(label));
}

/** Voluntary self-identification questions: answered "decline" when that option exists. */
export const EEO_RE = /\b(gender|sex|race|ethnicity|ethnic (origin|background)|hispanic|latino|veteran|disability|disabled|sexual orientation|transgender|pronouns?|lgbt)\b/i;
export const DECLINE_RE = /\b(decline|prefer not|not (wish|want) to|don'?t wish|do not wish|choose not|rather not|not to (say|disclose|answer)|i don'?t want to answer)\b/i;

/** The decline option of a demographic question, if it has one. */
export function declineOption(question: string, options: string[]): string | null {
  if (!EEO_RE.test(question)) return null;
  return options.find((o) => DECLINE_RE.test(o)) ?? null;
}

/** Resume / CV file fields (not cover letters or other documents). */
export function isResumeField(label: string, accept = ''): boolean {
  const l = label.toLowerCase();
  if (/cover|portfolio|transcript|photo|picture|certificate|id proof|other doc|additional/i.test(l)) return false;
  return /resume|résumé|cv\b|curriculum/i.test(l) || (!l.trim() && /pdf|doc/i.test(accept));
}

/** Key for "already applied to this company": lower-case, legal suffixes dropped. */
export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(private|pvt|limited|ltd|llp|inc|corp(oration)?|technologies|technology|solutions|services|software|labs?|india|co)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A stable key for an apply link (query and hash dropped, except Google Forms' id path). */
export function linkKey(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/(viewform|formResponse|apply|application)\/?$/i, '').replace(/\/$/, '')).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
