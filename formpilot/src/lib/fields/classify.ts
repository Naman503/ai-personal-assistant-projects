/**
 * Semantic classification of form fields.
 *
 * It looks at the HTML `autocomplete` token first, because that's the most
 * reliable signal, then at regexes over label/name/id/placeholder. The
 * vocabulary follows the WHATWG autofill tokens, plus common job-application
 * and profile concepts.
 *
 * The result drives two things:
 *  1. Instant answers from extracted facts (no LLM call for "Email").
 *  2. Safety: sensitive fields (passwords, cards, OTP, CAPTCHA) are never touched.
 */

import { normalizeText } from '../util';

export const SENSITIVE_TYPES = new Set([
  'password',
  'new-password',
  'current-password',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'one-time-code',
  'captcha',
  'pin',
  'ssn',
  'bank-account',
  'security-answer',
]);

interface Rule {
  type: string;
  re: RegExp;
  /** If true the type is factual: one exact value, no creative variants. */
  factual?: boolean;
}

// Order matters: first match wins. Sensitive patterns first.
const RULES: Rule[] = [
  { type: 'captcha', re: /captcha|recaptcha|verification code shown|enter the characters/ },
  { type: 'one-time-code', re: /\b(otp|one time (pass)?code|2fa|mfa|verification code|auth(entication)? code|totp)\b/ },
  { type: 'cc-csc', re: /\b(cvv|cvc|csc|security code|card verification)\b/ },
  { type: 'cc-number', re: /\b(card ?number|credit card|debit card|cc ?num|ccnum)\b/ },
  { type: 'cc-exp', re: /\b(expir(y|ation)( date)?|exp date|mm ?\/? ?yy)\b/ },
  { type: 'password', re: /\b(pass ?word|passwd|pwd|passcode)\b/ },
  // "PIN code" is the Indian postal code, so only a bare / ATM / UPI PIN counts as sensitive.
  { type: 'pin', re: /\b(atm |upi |card |security )?pin\b(?!\s?code)/ },
  { type: 'ssn', re: /\b(ssn|social security|aadha?ar|pan (card|number)|passport (no|number))\b/ },
  { type: 'bank-account', re: /\b(iban|account number|routing number|ifsc|sort code|swift)\b/ },
  { type: 'security-answer', re: /\b(security (question|answer)|mother'?s maiden)\b/ },

  { type: 'email', re: /\be ?mail\b/, factual: true },
  { type: 'tel', re: /\b(phone|mobile|cell|tel(ephone)?|contact (no|number)|whatsapp)\b/, factual: true },
  { type: 'given-name', re: /\b(first|given|fore) ?name\b|\bfname\b/, factual: true },
  { type: 'family-name', re: /\b(last|family|sur) ?name\b|\blname\b|\bsurname\b/, factual: true },
  { type: 'additional-name', re: /\bmiddle ?name\b/, factual: true },
  { type: 'username', re: /\b(user ?name|login id|handle)\b/, factual: true },
  { type: 'organization', re: /\b(company|organi[sz]ation|employer|current company|business name)\b/, factual: true },
  { type: 'organization-title', re: /\b(job ?title|designation|position|current (role|title)|occupation)\b/, factual: true },
  { type: 'linkedin', re: /linked ?in/, factual: true },
  { type: 'github', re: /git ?hub/, factual: true },
  { type: 'url', re: /\b(website|portfolio|personal (site|url)|homepage|url|blog)\b/, factual: true },
  { type: 'postal-code', re: /\b(zip|postal|post ?code|pin ?code|pincode)\b/, factual: true },
  { type: 'address-line2', re: /\b(address (line )?2|apt|apartment|suite|unit)\b/, factual: true },
  { type: 'street-address', re: /\b(address|street|address line 1|addr)\b/, factual: true },
  { type: 'address-level2', re: /\b(city|town|locality)\b/, factual: true },
  { type: 'address-level1', re: /\b(state|province|region|county)\b/, factual: true },
  { type: 'country', re: /\b(country|nation)\b/, factual: true },
  { type: 'bday', re: /\b(birth ?(day|date)|date of birth|dob)\b/, factual: true },
  { type: 'sex', re: /\b(gender|sex)\b/, factual: true },
  { type: 'nationality', re: /\b(nationality|citizenship)\b/, factual: true },
  { type: 'salary-current', re: /\b(current (ctc|salary|compensation)|ctc|present salary)\b/, factual: true },
  { type: 'salary-expected', re: /\b(expected (ctc|salary|compensation)|salary expectation|desired (salary|pay))\b/, factual: true },
  { type: 'notice-period', re: /\bnotice ?period\b/, factual: true },
  { type: 'experience-years', re: /\b(years? of (experience|exp)|total experience|experience \(?years\)?)\b/, factual: true },
  { type: 'education', re: /\b(degree|qualification|university|college|school|education)\b/, factual: true },
  { type: 'skills', re: /\bskills?\b/ },
  { type: 'cover-letter', re: /\bcover ?letter\b/ },
  { type: 'summary', re: /\b(about (you|yourself)|summary|bio(graphy)?|introduce yourself|profile summary|tell us about)\b/ },
  { type: 'motivation', re: /\b(why (do )?you want|why are you interested|why (this|our) (company|role)|motivation)\b/ },
  { type: 'name', re: /\b(full ?name|your name|name)\b/, factual: true },
];

/** autocomplete token → our semantic type. */
const AUTOCOMPLETE_MAP: Record<string, string> = {
  name: 'name',
  'given-name': 'given-name',
  'family-name': 'family-name',
  'additional-name': 'additional-name',
  email: 'email',
  tel: 'tel',
  'tel-national': 'tel',
  username: 'username',
  organization: 'organization',
  'organization-title': 'organization-title',
  'street-address': 'street-address',
  'address-line1': 'street-address',
  'address-line2': 'address-line2',
  'address-level1': 'address-level1',
  'address-level2': 'address-level2',
  'postal-code': 'postal-code',
  country: 'country',
  'country-name': 'country',
  bday: 'bday',
  sex: 'sex',
  url: 'url',
  'current-password': 'password',
  'new-password': 'password',
  'one-time-code': 'one-time-code',
  'cc-number': 'cc-number',
  'cc-csc': 'cc-csc',
  'cc-exp': 'cc-exp',
  'cc-exp-month': 'cc-exp',
  'cc-exp-year': 'cc-exp',
  'cc-name': 'cc-name',
};

const FACTUAL = new Set(RULES.filter((r) => r.factual).map((r) => r.type));

export interface ClassifyInput {
  inputType?: string;
  autocomplete?: string;
  label?: string;
  name?: string;
  htmlId?: string;
  placeholder?: string;
}

export function classifyField(f: ClassifyInput): string {
  const t = (f.inputType ?? '').toLowerCase();
  if (t === 'password') return 'password';
  if (t === 'email') return 'email';
  if (t === 'tel') return 'tel';
  if (t === 'url') return 'url';

  // autocomplete can contain section-/shipping/billing prefixes: take the last known token.
  const ac = (f.autocomplete ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  for (let i = ac.length - 1; i >= 0; i--) {
    const m = AUTOCOMPLETE_MAP[ac[i]];
    if (m) return m;
  }

  // Label is the strongest human signal; name/id are often noisy ("input_23").
  const labelText = normalizeText(`${f.label ?? ''} ${f.placeholder ?? ''}`);
  const attrText = normalizeText(splitIdent(`${f.name ?? ''} ${f.htmlId ?? ''}`));
  for (const text of [labelText, attrText]) {
    if (!text) continue;
    // Long questions ("Please state why you…") must not be mistaken for short factual fields,
    // but sensitive patterns are always checked.
    const long = text.split(' ').length > 7;
    for (const r of RULES) {
      if (long && r.factual) continue;
      if (r.re.test(text)) return r.type;
    }
  }
  return t === 'number' ? 'number' : t === 'date' ? 'date' : 'text';
}

/** "firstName" / "first_name" → "first name". */
export function splitIdent(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.[\]]+/g, ' ');
}

export const isSensitive = (semantic: string) => SENSITIVE_TYPES.has(semantic);
export const isFactual = (semantic: string) => FACTUAL.has(semantic) || semantic === 'date' || semantic === 'number';

/** Human-friendly name for a semantic type (for fact keys). */
export function semanticLabel(type: string): string {
  const map: Record<string, string> = {
    'given-name': 'First name',
    'family-name': 'Last name',
    'additional-name': 'Middle name',
    name: 'Full name',
    email: 'Email',
    tel: 'Phone',
    organization: 'Current company',
    'organization-title': 'Job title',
    'street-address': 'Street address',
    'address-line2': 'Address line 2',
    'address-level2': 'City',
    'address-level1': 'State / Province',
    'postal-code': 'Postal code',
    country: 'Country',
    bday: 'Date of birth',
    sex: 'Gender',
    linkedin: 'LinkedIn URL',
    github: 'GitHub URL',
    url: 'Website',
    'salary-current': 'Current salary',
    'salary-expected': 'Expected salary',
    'notice-period': 'Notice period',
    'experience-years': 'Years of experience',
    education: 'Education',
    nationality: 'Nationality',
    username: 'Username',
  };
  return map[type] ?? type;
}
