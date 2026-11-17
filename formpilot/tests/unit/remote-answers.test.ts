import { describe, expect, it } from 'vitest';
import { remoteAnswer, TIMEZONE_TEXT } from '@/lib/fields/answers';

const yn = [
  { value: 'Yes', label: 'Yes' },
  { value: 'No', label: 'No' },
];

describe('remote job answers', () => {
  it('says No to work authorization abroad', () => {
    expect(remoteAnswer({ label: 'Are you legally authorized to work in the United States?', options: yn })).toBe('No');
    expect(remoteAnswer({ label: 'Are you eligible to work in the UK?', options: [] })).toBe('No');
  });
  it('gives the time zone, or the IST option', () => {
    expect(remoteAnswer({ label: 'What time zone are you based in?', options: [] })).toBe(TIMEZONE_TEXT);
    expect(remoteAnswer({ label: 'Timezone', options: [{ value: 'pst', label: 'PST (UTC-8)' }, { value: 'ist', label: 'IST (UTC+5:30)' }] })).toBe('IST (UTC+5:30)');
  });
  it('says Yes to overlapping with US hours', () => {
    expect(remoteAnswer({ label: 'Are you able to work at least 4 hours overlapping with US Eastern time?', options: yn })).toBe('Yes');
    expect(remoteAnswer({ label: 'Can you be available during EST business hours?', options: [] })).toBe('Yes');
  });
  it('leaves other questions alone', () => {
    expect(remoteAnswer({ label: 'Have you worked with React Native?', options: yn })).toBeNull();
    expect(remoteAnswer({ label: 'Expected salary', options: [] })).toBeNull();
  });
});

import { checkEligibility } from '@/lib/fields/eligibility';
import { DEFAULTS } from '@/lib/settings-core';

describe('site switched off', () => {
  it('no suggestions on a blocked site, except your own shortcut', () => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Your bio');
    document.body.appendChild(input);
    const s = structuredClone(DEFAULTS);
    s.behavior.blockedSites = [location.hostname || 'localhost'];
    expect(checkEligibility(input, s).ok).toBe(false);
    expect(checkEligibility(input, s).reason).toMatch(/off on this site/);
    expect(checkEligibility(input, s, true).ok).toBe(true);
  });
});

import { locationChoiceAnswer } from '@/lib/fields/answers';
const o = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));
describe('location dropdowns', () => {
  it('picks your city even when spelled Bangalore (Lever, SmartWorking)', () => {
    expect(locationChoiceAnswer({ label: 'In which location did you find the job?', options: o(['Select...', 'India', 'Delhi NCR', 'Bangalore', 'Hyderabad', 'Chandigarh', 'Pune', 'Indore']) })).toBe('Bangalore');
  });
  it('falls back to Remote, then India', () => {
    expect(locationChoiceAnswer({ label: 'Preferred location', options: o(['London', 'Remote', 'Berlin']) })).toBe('Remote');
    expect(locationChoiceAnswer({ label: 'Location', options: o(['India', 'Singapore']) })).toBe('India');
  });
  it('leaves non-place lists and other questions alone', () => {
    expect(locationChoiceAnswer({ label: 'How did you hear about us?', options: o(['LinkedIn', 'Referral']) })).toBeNull();
    expect(locationChoiceAnswer({ label: 'Location', options: o(['Yes', 'No']) })).toBeNull();
  });
});

import { consentToTick } from '@/lib/sitepilot/detect';
describe('consent boxes', () => {
  it('ticks a required privacy consent that also mentions future opportunities', () => {
    expect(consentToTick('Required. By submitting this application, I agree that I have read the Privacy Policy and confirm that the COOL company store my personal details to be able to process my job application and future opportunities', false)).toBe(true);
  });
  it('never ticks an optional marketing box', () => {
    expect(consentToTick('I agree to receive newsletters and future opportunities', false)).toBe(false);
    expect(consentToTick('Keep me informed about future opportunities (talent community)', false)).toBe(false);
  });
});
