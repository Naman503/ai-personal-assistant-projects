/**
 * Site Pilot's "look and act" step: the local model sees a screenshot of the page and the list of
 * its controls, and picks ONE action. Values it types are checked against the controls here;
 * anything malformed becomes a safe "stop".
 */
import type { AgentAction, PageSnapshot } from './types';

export const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    do: { type: 'string', enum: ['fill', 'choose', 'check', 'click', 'upload', 'scroll', 'next', 'submit', 'stop'] },
    id: { type: 'string' },
    value: { type: 'string' },
    option: { type: 'string' },
    why: { type: 'string' },
    needsYou: { type: 'boolean' },
  },
  required: ['do', 'why'],
} as const;

export const AGENT_SYSTEM = `You operate a web browser to complete a job application form for the candidate described below. You see a screenshot of the browser window and a list of the page's controls (fields and buttons) with ids.

Choose exactly ONE next action and answer with JSON only:
- {"do":"fill","id":"f3","value":"..."}       type into a text field (replaces what is there)
- {"do":"choose","id":"f4","option":"..."}    pick an option (dropdown, radio, yes/no buttons); option = the option's exact text
- {"do":"check","id":"f5"}                    tick a checkbox
- {"do":"upload","id":"f2"}                   put the candidate's resume into a file field
- {"do":"click","id":"b2"}                    press a button or link (for example "Apply", "Next", "Add")
- {"do":"next"}                               go to the next step of the form
- {"do":"submit"}                             send the application
- {"do":"scroll"}                             scroll down to see more of the page
- {"do":"stop","why":"...","needsYou":true}   the candidate must do this part
Always include "why": a few words on why.

Rules:
1. Answers come only from the candidate's facts, resume and profile below. Never invent personal data (IDs, numbers, dates, links) that isn't there.
2. {{CLAIMS}} Willing to relocate, work on-site or in shifts → Yes; needs visa sponsorship → No; notice period, CTC and location → from the facts.
3. Demographic questions (gender, race, veteran, disability): choose "Decline to self-identify" or the closest option.
4. Tick a required privacy/terms/consent box. Never tick newsletters, marketing, job alerts or "talent community" boxes, and answer No to "stay up to date" or "job alerts" questions.
5. If the page asks to sign in, create an account or a password, solve a CAPTCHA, take a test, verify a phone/email code, or pay: stop with needsYou true.
6. "submit" only when every required field is filled, no error message is visible, and the resume is attached (if the form has a resume field).
7. Fix errors first: a field marked with an error or listed under MISSING comes before anything else.
8. Fields that already hold a correct value: leave them.
9. If the page is not an application form (a job description), click its Apply button. If it says the application was received, choose stop with why "confirmed".`;

export interface AgentInput {
  snap: PageSnapshot;
  job: { title: string; company: string; description?: string };
  profile: string;
  facts: string;
  history: string[];
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function buildAgentPrompt(i: AgentInput): string {
  const controls = i.snap.controls.map((c) => {
    const parts = [`${c.id} [${c.kind}${c.required ? ', required' : ''}] "${short(c.label || '(no label)', 140)}"`];
    if (c.options?.length) parts.push(`options: ${c.options.slice(0, 15).map((o) => JSON.stringify(short(o, 60))).join(', ')}`);
    if (c.value !== undefined && c.kind !== 'button' && c.kind !== 'link') parts.push(`value: ${JSON.stringify(short(c.value, 80))}`);
    if (c.error) parts.push(`ERROR: ${short(c.error, 120)}`);
    return parts.join(' · ');
  });
  return [
    `CANDIDATE PROFILE:\n${short(i.profile, 1500)}`,
    `CANDIDATE FACTS:\n${short(i.facts, 2500)}`,
    `JOB: ${i.job.title || '?'} at ${i.job.company || '?'}${i.job.description ? `\n${short(i.job.description, 800)}` : ''}`,
    `PAGE: ${short(i.snap.title, 120)} — ${short(i.snap.url, 160)} (system: ${i.snap.ats})`,
    i.snap.text ? `PAGE TEXT: ${short(i.snap.text, 700)}` : '',
    `CONTROLS:\n${controls.join('\n') || '(none found)'}`,
    i.snap.missing.length ? `MISSING (required, empty): ${i.snap.missing.join('; ')}` : 'MISSING: none',
    i.snap.errors.length ? `ERRORS SHOWN: ${i.snap.errors.join('; ')}` : 'ERRORS SHOWN: none',
    i.history.length ? `YOUR LAST ACTIONS (most recent last):\n${i.history.slice(-8).join('\n')}` : '',
    i.snap.submitReady
      ? 'STATUS: the form looks COMPLETE: every required field has a value, no error is shown, and the Submit button is on the page. Unless one of the values above is wrong for this candidate, answer {"do":"submit","why":"complete"}. Do not re-type fields that already hold the right value.'
      : '',
    'Your one next action as JSON:',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const CLAIMS = {
  truthful: 'Be truthful: years with a skill or technology come from the profile, facts or resume; if they never mention it, the answer is 0 / No / the lowest option. Never claim experience the candidate does not have.',
  'keep-in': "Keep the candidate in the running: years of experience with a skill the job needs → the profile's number, else 3; having worked with a needed skill → Yes unless the facts say otherwise.",
};

/** The agent's standing instructions, with the candidate's brief when there is one. */
export function agentSystem(style: 'truthful' | 'keep-in' = 'truthful', brief = ''): string {
  const base = AGENT_SYSTEM.replace('{{CLAIMS}}', CLAIMS[style]);
  return brief.trim() ? `${base}\n\nCANDIDATE BRIEF (always follow it):\n${brief.trim()}` : base;
}

/** Parse the model's reply into a safe action. Unknown ids or missing values become a "stop". */
export function parseAction(text: string, snap: PageSnapshot): AgentAction {
  let o: Record<string, unknown>;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    o = JSON.parse(m ? m[0] : text);
  } catch {
    return { do: 'stop', why: 'the model gave no usable answer' };
  }
  const doIt = String(o.do ?? '').toLowerCase();
  const id = String(o.id ?? '').trim();
  const known = snap.controls.find((c) => c.id === id);
  const why = String(o.why ?? '').slice(0, 200);
  switch (doIt) {
    case 'fill': {
      const value = String(o.value ?? '').trim();
      if (!known || !value || known.kind === 'button' || known.kind === 'link' || known.kind === 'file') return { do: 'stop', why: `bad fill (${id || 'no id'})` };
      return { do: 'fill', id, value: value.slice(0, 4000) };
    }
    case 'choose': {
      const option = String(o.option ?? o.value ?? '').trim();
      if (!known || !option) return { do: 'stop', why: `bad choice (${id || 'no id'})` };
      return { do: 'choose', id, option };
    }
    case 'check':
    case 'upload':
    case 'click':
      if (!known) return { do: 'stop', why: `unknown control ${id || '(none)'}` };
      return { do: doIt, id } as AgentAction;
    case 'scroll':
    case 'next':
    case 'submit':
      return { do: doIt } as AgentAction;
    case 'stop':
      return { do: 'stop', why: why || 'stopped', needsYou: o.needsYou === true || o.needsYou === 'true' };
    default:
      return { do: 'stop', why: `unknown action "${doIt}"` };
  }
}

/** A short line for the step log ("fill f3 Notice period = 30 days"). */
export function describeAction(a: AgentAction, snap: PageSnapshot): string {
  const label = 'id' in a ? (snap.controls.find((c) => c.id === a.id)?.label ?? a.id).slice(0, 60) : '';
  switch (a.do) {
    case 'fill':
      return `fill "${label}" = ${JSON.stringify(a.value.slice(0, 60))}`;
    case 'choose':
      return `choose "${label}" = ${JSON.stringify(a.option.slice(0, 60))}`;
    case 'check':
      return `tick "${label}"`;
    case 'upload':
      return `upload the resume to "${label}"`;
    case 'click':
      return `press "${label}"`;
    case 'stop':
      return `stop: ${a.why}`;
    default:
      return a.do;
  }
}
