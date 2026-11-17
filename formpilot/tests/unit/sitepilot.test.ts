import { describe, expect, it, beforeEach } from 'vitest';
import { OPT_IN_RE, blockerIn, CLOSED_RE, companyKey, consentToTick, declineOption, detectAts, isResumeField, linkKey, needsAccount } from '@/lib/sitepilot/detect';
import { buildAgentPrompt, parseAction } from '@/lib/sitepilot/agent';
import { isLive, siteSettings } from '@/lib/sitepilot/runner';
import { enqueue, nextQueued, companyCount, spDb } from '@/lib/sitepilot/db';
import { ollamaSettings, resetLocalRun, rpmFor, type LocalRun } from '@/lib/llm/local-run';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import type { PageSnapshot } from '@/lib/sitepilot/types';

describe('detect', () => {
  it('recognises application systems', () => {
    expect(detectAts('https://docs.google.com/forms/d/e/1FAIpQ/viewform')).toBe('google-forms');
    expect(detectAts('https://job-boards.greenhouse.io/acme/jobs/123')).toBe('greenhouse');
    expect(detectAts('https://acme.com/careers?gh_jid=1', '<iframe id="grnhse_iframe">')).toBe('greenhouse');
    expect(detectAts('https://jobs.lever.co/acme/uuid/apply')).toBe('lever');
    expect(detectAts('https://jobs.ashbyhq.com/acme/uuid/application')).toBe('ashby');
    expect(detectAts('https://apply.workable.com/acme/j/ABC/apply')).toBe('workable');
    expect(detectAts('https://acme.com/jobs/1')).toBe('other');
  });
  it('leaves account-only systems for you', () => {
    expect(needsAccount('https://acme.wd5.myworkdayjobs.com/en-US/External/job/1')).toBe(true);
    expect(needsAccount('https://acme.taleo.net/careersection/2/jobapply.ftl')).toBe(true);
    expect(needsAccount('https://jobs.lever.co/acme/1/apply')).toBe(false);
  });
  it('spots closed jobs and blockers', () => {
    expect(CLOSED_RE.test('This job is no longer accepting applications')).toBe(true);
    expect(CLOSED_RE.test('We have 404 engineers')).toBe(false);
    expect(blockerIn('Please sign in to apply')).toMatch(/sign in/);
    expect(blockerIn('Enter the OTP sent to your phone')).toMatch(/code/);
    expect(blockerIn('Take the coding test on HackerRank')).toMatch(/test/);
    expect(blockerIn('Shortlisted candidates take a coding test at a later stage')).toBeNull();
  });
  it('ticks consent, never marketing', () => {
    expect(consentToTick('I agree to the Privacy Policy *', false)).toBe(true);
    expect(consentToTick('I consent to the processing of my personal data', true)).toBe(true);
    expect(consentToTick('Send me job alerts and newsletters', true)).toBe(false);
    expect(consentToTick('Join our talent community for future opportunities', false)).toBe(false);
    expect(consentToTick('I agree to the privacy policy', false)).toBe(false); // optional: left alone
  });
  it('spots opt-in questions', () => {
    expect(OPT_IN_RE.test('Would you like to stay up to date with MongoDB?')).toBe(true);
    expect(OPT_IN_RE.test('Receive alerts for similar jobs?')).toBe(true);
    expect(OPT_IN_RE.test('Are you willing to relocate?')).toBe(false);
  });
  it('declines demographic questions when it can', () => {
    expect(declineOption('Gender', ['Male', 'Female', 'Decline to self-identify'])).toBe('Decline to self-identify');
    expect(declineOption('Disability status', ['Yes', 'No', 'I do not want to answer'])).toBe('I do not want to answer');
    expect(declineOption('Notice period', ['Immediate', 'Prefer not to say'])).toBeNull();
  });
  it('finds resume fields only', () => {
    expect(isResumeField('Resume/CV *')).toBe(true);
    expect(isResumeField('Cover letter')).toBe(false);
    expect(isResumeField('', '.pdf,.docx')).toBe(true);
  });
  it('keys companies and links', () => {
    expect(companyKey('Acme Technologies Pvt. Ltd.')).toBe(companyKey('ACME'));
    expect(linkKey('https://jobs.lever.co/acme/1/apply?src=x')).toBe(linkKey('https://jobs.lever.co/acme/1'));
  });
});

const snap: PageSnapshot = {
  url: 'https://x.test/apply',
  title: 'Apply',
  ats: 'other',
  text: '',
  controls: [
    { id: 'f1', kind: 'select', label: 'Notice period', options: ['Immediate', '30 days'], required: true, value: '' },
    { id: 'f2', kind: 'text', label: 'Email', value: '' },
    { id: 'b1', kind: 'button', label: 'Submit application' },
  ],
  missing: ['Notice period'],
  errors: [],
  submitReady: false,
};

describe('agent', () => {
  it('parses actions and rejects unsafe ones', () => {
    expect(parseAction('{"do":"choose","id":"f1","option":"30 days","why":"facts"}', snap)).toEqual({ do: 'choose', id: 'f1', option: '30 days' });
    expect(parseAction('noise {"do":"fill","id":"f2","value":"a@b.c","why":"x"} noise', snap)).toEqual({ do: 'fill', id: 'f2', value: 'a@b.c' });
    expect(parseAction('{"do":"fill","id":"b1","value":"x"}', snap).do).toBe('stop');
    expect(parseAction('{"do":"click","id":"zz"}', snap).do).toBe('stop');
    expect(parseAction('not json', snap).do).toBe('stop');
    expect(parseAction('{"do":"stop","why":"login","needsYou":true}', snap)).toEqual({ do: 'stop', why: 'login', needsYou: true });
  });
  it('puts problems and options in the prompt', () => {
    const p = buildAgentPrompt({ snap, job: { title: 'RN Engineer', company: 'Acme' }, profile: 'JS/TS', facts: '- Notice: 30 days', history: ['pressed Next'] });
    expect(p).toContain('MISSING (required, empty): Notice period');
    expect(p).toContain('options: "Immediate", "30 days"');
    expect(p).toContain('pressed Next');
  });
});

describe('runner settings', () => {
  it('uses only the local model', () => {
    const s = siteSettings(DEFAULT_SETTINGS);
    expect(s.providers).toHaveLength(1);
    expect(s.providers[0].kind).toBe('ollama');
    expect(s.providers[0].model).toBe('gemma4:12b');
    expect(s.generation.fallback).toBe(false);
  });
  it('is live only on ticked systems', () => {
    const sp = { ...DEFAULT_SETTINGS.sitePilot, liveAts: ['lever'] };
    expect(isLive(sp, 'lever')).toBe(true);
    expect(isLive(sp, 'greenhouse')).toBe(false);
    expect(isLive({ ...sp, liveAts: ['other'] }, 'other')).toBe(true);
  });
});

describe('queue', () => {
  beforeEach(async () => {
    await spDb().jobs.clear();
  });
  it('dedupes by link and by company + title, and puts yours first', async () => {
    expect((await enqueue([{ url: 'https://jobs.lever.co/acme/1', title: 'RN Dev', company: 'Acme', source: 'naukri' }])).added).toBe(1);
    expect((await enqueue([{ url: 'https://jobs.lever.co/acme/1/apply', source: 'manual' }])).added).toBe(0);
    expect((await enqueue([{ url: 'https://other.example/x', title: 'RN Dev', company: 'Acme Pvt Ltd', source: 'naukri' }])).added).toBe(0);
    await enqueue([{ url: 'https://forms.gle/abc', source: 'manual' }]);
    expect((await nextQueued())?.url).toBe('https://forms.gle/abc');
  });
  it('counts recent applications per company', async () => {
    await enqueue([{ url: 'https://a.example/1', title: 'A', company: 'Acme', source: 'manual' }]);
    const j = (await spDb().jobs.toArray())[0];
    await spDb().jobs.update(j.id, { status: 'sent', doneAt: Date.now() });
    expect(await companyCount('ACME Technologies')).toBe(1);
  });
});

describe('local run', () => {
  const c: LocalRun = { whenActive: 'slow', idleMinutes: 3, keepAlive: '30m', numCtx: 8192, lightModel: 'gemma4:e4b', rpmActive: 2, rpmIdle: 6 };
  beforeEach(() => resetLocalRun());
  it('slows down and lightens while you work', () => {
    expect(rpmFor(true, c)).toBe(2);
    expect(rpmFor(false, c)).toBe(6);
    expect(ollamaSettings('gemma4:12b', true, c)).toEqual({ model: 'gemma4:e4b', keep_alive: '5m', options: { num_ctx: 8192 } });
    expect(ollamaSettings('gemma4:12b', false, c).model).toBe('gemma4:12b');
    expect(ollamaSettings('gemma4:12b', true, { ...c, whenActive: 'full' }).model).toBe('gemma4:12b');
    expect(ollamaSettings('m', false, { ...c, keepAlive: '0' }).keep_alive).toBe(0);
  });
});
