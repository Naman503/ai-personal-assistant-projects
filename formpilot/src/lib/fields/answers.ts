/** Answers decided by rule, without the AI. Pure functions (used in the background). */
import type { FieldContext } from '../types';
import { parseDurationDays, rangeOption } from './adapt';
import { bestOption, exactOption, splitChoices } from './fill';

/** A stored answer fits a choice question only when it names one of the options. */
export function answerFitsOptions(answer: string, f: Pick<FieldContext, 'options' | 'inputType' | 'label'>): boolean {
  const opts = f.options ?? [];
  if (!opts.length) return true;
  const o = opts.map((x) => ({ value: x.value, label: x.label || x.value }));
  const parts = f.inputType === 'checkbox' ? splitChoices(answer, o.map((x) => x.label)) : [answer];
  return parts.length > 0 && parts.every((p) => !!exactOption(p, o) || rangeOption(p, o.map((x) => x.label), f.label) >= 0 || !!bestOption(p, o));
}

const START_Q = /\b(earliest|soonest)\b.*\b(start|join|begin)|\b(start|joining|join|availability|available)\s*(date|from|on)\b|\bwhen can you (start|join)\b|\bdate (of|you can) (join|start)/i;

/** "What is your earliest start date?" in a date/text box → today + notice period (ISO; the fill adapts the format). */
export function startDateAnswer(f: Pick<FieldContext, 'label' | 'kind' | 'inputType' | 'options'>, notice?: string, now = new Date()): string | null {
  if (!START_Q.test(f.label ?? '') || f.options?.length || f.kind === 'textarea' || f.kind === 'select') return null;
  if (!['date', 'text', 'search', ''].includes(f.inputType ?? '')) return null;
  const days = (notice ? parseDurationDays(notice) : null) ?? 30;
  const d = new Date(now.getTime() + Math.max(0, days) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** "How many years of (work) experience do you have with Flutter / in Sales / overall?" */
export const YEARS_Q = /\b(how many|number of|total)\b[^?]*\byears?\b|\byears? of (work |professional |relevant |hands-on )?experience\b|\bexperience\b[^?]*\(in years\)/i;

/** Experience you didn't state, for skills you have: 3 years (your rule). */
export const DEFAULT_YEARS = 3;

/**
 * The skill a "years of experience" question asks about ("…with Ruby on Rails?" → "ruby on rails"),
 * or null when it asks about your overall / professional experience.
 */
export function askedSkill(label: string): string | null {
  const q = label.toLowerCase().replace(/[“”"']/g, '');
  const m = q.match(/^.*\b(?:with|in|using)\s+([^?:*]+?)\s*(?:\?|:|\*|$|\(only|\(in years)/);
  if (!m) return null;
  const skill = m[1].replace(/^(the|a|an)\s+/, '').replace(/\b(development|programming( language)?|framework|experience|hands-on|professional|work)\b/g, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!skill || /^(total|overall|years?|it|industry|the industry|software( development| engineering)?|engineering|this (role|field|domain)|the role you'?re applying for.*|your (field|domain|role)|work|professional|relevant)$/.test(skill)) return null;
  return skill;
}

/** Broad areas that fit any software engineer's resume: never answered 0. */
const BROAD = /\b(software|full[- ]?stack|backend|back-end|frontend|front-end|web|mobile|apps?|api|rest|databases?|sql|cloud|devops|git|agile|scrum|testing|debugging|ai|llms?|genai|generative|rag|agentic|chatbots?|machine learning|ml|javascript|typescript|programming|coding|engineering|microservices?|linux|data structures|algorithms|system design|product)\b/;
const ALIAS: [RegExp, string][] = [[/\breact\.?js\b|\breactjs\b/, 'react'], [/\bnode\.?js\b|\bnodejs\b/, 'node'], [/\bpostgres(ql)?\b/, 'postgresql'], [/\bnext\.?js\b/, 'next'], [/\bamazon web services\b/, 'aws'], [/\bgolang\b/, 'go']];
const norm = (t: string) => ALIAS.reduce((x, [re, to]) => x.replace(re, to), t.toLowerCase());

/** Is this skill on your resume / in your saved skills? Broad areas count as yes. */
export function knowsSkill(skill: string, skills: string): boolean {
  const s = norm(skill);
  if (BROAD.test(s)) return true;
  const mine = norm(skills).split(/[,;|/\n]+|\band\b/).map((x) => x.replace(/[^a-z0-9+#. ]/g, '').trim()).filter((x) => x.length > 0);
  const words = s.split(/[^a-z0-9+#.]+/).filter((w) => w.length > 1 && !/^(and|or|with|like|such|as|using|etc|any|public|apps?)$/.test(w));
  return mine.some((m) => (m.length > 1 && (s === m || new RegExp(`(^|[^a-z0-9])${m.replace(/[.+#]/g, '\\$&')}([^a-z0-9]|$)`).test(s))) || words.some((w) => w === m));
}

/**
 * Fix an experience answer. A skill that isn't on your resume or in your saved skills: 0 (17 Nov:
 * "3 years" of Ruby on Rails, C#, PHP and Beckhoff went out). Your skills and your overall
 * experience: blank, 0, "none" or "less than a year" becomes 3 years; numbers from your resume stay.
 */
export function experienceAnswer(f: Pick<FieldContext, 'label' | 'options'>, answer: string | undefined, skills = ''): string | null {
  if (!YEARS_Q.test(f.label ?? '')) return null;
  const opts = (f.options ?? []).map((o) => o.label || o.value);
  const skill = askedSkill(f.label ?? '');
  if (skill && skills && !knowsSkill(skill, skills)) {
    if (!opts.length) return '0';
    const zero = opts.find((o) => /^\s*(0|none|no experience|less than 1|< ?1|0\s*-|fresher)/i.test(o));
    return zero ?? null;
  }
  const a = (answer ?? '').trim();
  const n = parseFloat(a.replace(/,/g, ''));
  const weak = !a || /^(0+(\.0+)?|none|no|nil|n\/?a|not applicable|-|less than (a|1) year|fresher)\b/i.test(a) || (Number.isFinite(n) && n < 1);
  if (!weak) return null;
  return opts.length ? `${DEFAULT_YEARS} years` : String(DEFAULT_YEARS);
}

/** "In how many days can you join?" / "We need immediate joiners: your notice period?" → your notice, in days. */
const JOIN_DAYS_Q = /\b(how many days|within how many days|how soon|how quickly)\b[^?]*\b(join|start|onboard)|\bimmediate joiners?\b[^?]*\bnotice\b|\bjoining (time|period)\b/i;
export function joinDaysAnswer(f: Pick<FieldContext, 'label' | 'options' | 'kind'>, notice?: string): string | null {
  if (!JOIN_DAYS_Q.test(f.label ?? '') || f.options?.length || f.kind === 'textarea') return null;
  const days = (notice ? parseDurationDays(notice) : null) ?? 30;
  return String(days);
}

/** "Last working day (if serving notice)": you aren't serving notice, so it stays empty (never a made-up date). */
const LWD_Q = /\b(last working day|lwd|relieving date)\b/i;
export function notServingNotice(f: Pick<FieldContext, 'label'>, serving?: string): boolean {
  return LWD_Q.test(f.label ?? '') && !(serving && /\b(yes|serving)\b/i.test(serving));
}

/**
 * Questions that only screen you out when answered "No": commuting, relocating, on-site or
 * hybrid work, shifts, weekends, background checks, joining on time. Answered Yes by rule.
 * (Not for facts about you, like where you live now or your visa: those come from memory.)
 */
const KEEP_IN = /\b(comfortable|willing|open|okay|ok|able|ready|happy|agree|available)\b[^?]*\b(commut|relocat|on-?site|onsite|in[- ]office|office|hybrid|work from (the )?office|wfo|travel|shifts?|night|weekends?|rotational|join (immediately|within|in)|background (check|verification)|bond|contract|probation|notice period buy ?out)/i;

export function keepInAnswer(f: Pick<FieldContext, 'label' | 'options'>): string | null {
  if (!KEEP_IN.test(f.label ?? '')) return null;
  const opts = f.options ?? [];
  if (!opts.length) return 'Yes';
  const yes = opts.find((o) => /^\s*yes\b/i.test(o.label || o.value));
  return yes ? yes.label || yes.value : null;
}

/**
 * Questions whose honest answer is "none" unless your memory says otherwise (17 Nov: "Current
 * Variable Compensation" got the full CTC; "If yes, please provide their name(s)" got your own
 * name). Variable pay / bonus / stock: 0. A follow-up asking who you know or who referred you: Not
 * applicable. Facts you saved still win (they're checked first).
 */
const NO_VARIABLE = /\b(variable (pay|compensation|component|ctc|part)|bonus|incentives?|unvested|esops?|rsus?|stock options?|joining bonus)\b/i;
const NO_ONE = /^\s*if (yes|so)\b[^?]*\b(their|the|his|her) names?\b|^\s*if (yes|so)\b[^?]*\b(name\(s\)|names? of|employee names?|referr|relative|who)\b/i;

export function noneAnswer(f: Pick<FieldContext, 'label' | 'options'>): string | null {
  const q = f.label ?? '';
  if (f.options?.length) return null;
  if (NO_VARIABLE.test(q) && !/\b(expect|expected|desired)\b/i.test(q)) return '0';
  if (NO_ONE.test(q)) return 'Not applicable';
  return null;
}

/**
 * Questions where "Yes" screens you out and "No" is your situation: non-compete agreements,
 * needing visa sponsorship (in India), criminal records. Answered No by rule.
 */
const SCREEN_OUT = /\b(non[- ]?compete|restrictive covenant|(require|need)s?\b[^?]*\bsponsorship|criminal (record|conviction|charge)|been convicted|pending (legal|disciplinary)|service bond with)/i;

export function screenOutAnswer(f: Pick<FieldContext, 'label' | 'options'>): string | null {
  if (!SCREEN_OUT.test(f.label ?? '')) return null;
  const opts = f.options ?? [];
  if (!opts.length) return 'No';
  const no = opts.find((o) => /^\s*no\b/i.test(o.label || o.value));
  return no ? no.label || no.value : null;
}

/**
 * Remote jobs from abroad (17 Nov 2026, the remote plan). Facts about you that global forms ask
 * and that don't change: you work from India (IST), 2 PM – 11 PM IST, and you aren't authorized
 * to work in the US / UK / EU / Canada / Australia. Saved facts and answers still win (checked
 * first). Overlap or working-hours yes/no questions are answered Yes (you can).
 */
export const TIMEZONE_TEXT = 'India (IST, UTC+5:30). Available 2 PM – 11 PM IST: full overlap with Europe and the Middle East, 3–4 hours with US Eastern.';
const TZ_Q = /\b(time ?zone|timezone|which hours|working hours|hours of overlap|overlap (with|hours)|located in which (country|region))\b/i;
const OVERLAP_YN = /\b(able|willing|comfortable|available|can you|open)\b[^?]*\b(overlap|work|be available)\b[^?]*\b(us|u\.s\.|est|edt|pst|pdt|cet|gmt|utc|europe|european|eastern|pacific|central)\b[^?]*\b(hours?|time ?zone|business hours|working hours|time)\b/i;
const AUTH_Q = /\b(legally )?(authori[sz]ed|eligible|permitted|right) to work (in|for) (the )?(us|u\.s\.|usa|united states|uk|u\.k\.|united kingdom|eu|european union|canada|australia|germany|netherlands|ireland|singapore)\b/i;

export function remoteAnswer(f: Pick<FieldContext, 'label' | 'options'>): string | null {
  const q = f.label ?? '';
  const opts = f.options ?? [];
  const pick = (re: RegExp) => opts.find((o) => re.test(o.label || o.value));
  if (AUTH_Q.test(q)) {
    if (!opts.length) return 'No';
    const no = pick(/^\s*no\b/i);
    return no ? no.label || no.value : null;
  }
  if (OVERLAP_YN.test(q)) {
    if (!opts.length) return /\bhow many\b/i.test(q) ? '4' : 'Yes';
    const yes = pick(/^\s*yes\b/i);
    if (yes) return yes.label || yes.value;
  }
  if (TZ_Q.test(q)) {
    if (!opts.length) return /\bhow many\b/i.test(q) ? '4' : TIMEZONE_TEXT;
    const ist = pick(/\b(ist|india|asia\/kolkata|utc ?\+ ?5:?30|gmt ?\+ ?5:?30|\+05:30)\b/i);
    return ist ? ist.label || ist.value : null;
  }
  return null;
}

/**
 * Location dropdowns ("In which location did you find the job?", "Preferred location", "Which
 * office?") whose options are places. 18 Nov, a Lever form (SmartWorking): left on "Select…"
 * because your city is saved as "Bengaluru" and the option said "Bangalore"; the site refused the
 * application. Pick your city (Bengaluru = Bangalore), else Remote, else India, else Indore.
 */
const LOCATION_Q = /\b(location|city|office|based|work from|relocat\w* to|which (place|city|location))\b/i;
const PLACE = /\b(india|bengaluru|bangalore|delhi|ncr|gurgaon|gurugram|noida|mumbai|pune|hyderabad|chennai|kolkata|indore|chandigarh|ahmedabad|jaipur|kochi|remote|anywhere|apac|asia|emea|europe|united states|usa|uk|london|singapore|dubai)\b/i;

export function locationChoiceAnswer(f: Pick<FieldContext, 'label' | 'options'>): string | null {
  const opts = (f.options ?? []).map((o) => o.label || o.value).filter((o) => o && !/^(select|choose|--|please)/i.test(o.trim()));
  if (opts.length < 2 || !LOCATION_Q.test(f.label ?? '')) return null;
  if (opts.filter((o) => PLACE.test(o)).length < Math.ceil(opts.length / 2)) return null; // not a list of places
  for (const re of [/\b(bengaluru|bangalore)\b/i, /\bremote\b|\banywhere\b/i, /^india$|\bindia\b/i, /\bindore\b/i]) {
    const hit = opts.find((o) => re.test(o));
    if (hit) return hit;
  }
  return null;
}
