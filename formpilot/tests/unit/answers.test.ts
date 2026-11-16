import { describe, expect, it } from 'vitest';
import { answerFitsOptions, startDateAnswer } from '@/lib/fields/answers';
import { checkboxGroups } from '@/lib/fields/context';
import { radioGroupLabel, radioOptionLabel } from '@/lib/fields/radios';
import { fillCheckboxGroup, splitChoices } from '@/lib/fields/fill';
import { bestSuggestion } from '@/lib/fields/typeahead';

const INDUSTRIES = ['Administrative/ Executive Assistance', 'Construction', 'Customer Service', 'Digital Marketing', 'E-Commerce', 'Accounting/Bookkeeping', 'IT/Tech', 'Real Estate', 'Sales/Lead Generation'];
const page = () => `<div id="form"><div><span>Which industries have you worked in? (Select all that apply.)*</span>
  <fieldset role="group">${INDUSTRIES.map((t, i) => `<div><input type="checkbox" id="i${i}" name="ind"><label for="i${i}">${t}</label></div>`).join('')}</fieldset></div>
  <div><input type="checkbox" id="consent"><label for="consent">I agree to the privacy policy</label></div>
  <label for="city">City</label><input id="city" type="text"></div>`;

describe('select-all-that-apply checkboxes', () => {
  it('groups the list, not the lone consent box, and reads its question and options', () => {
    document.body.innerHTML = page();
    const groups = checkboxGroups(document.getElementById('city')!);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(INDUSTRIES.length);
    expect(radioGroupLabel(groups[0])).toBe('Which industries have you worked in? (Select all that apply.)');
    expect(groups[0].map((b) => radioOptionLabel(b, groups[0]))).toEqual(INDUSTRIES);
  });

  it('groups LinkedIn-style boxes without a name or fieldset', () => {
    document.body.innerHTML = `<div id="f"><p>Which industries have you worked in?*</p><div>${INDUSTRIES.slice(0, 4).map((t, i) =>
      `<div><div><input type="checkbox" id="x${i}" aria-label="${t}"><label for="x${i}"></label></div><div><p>${t}</p></div></div>`).join('')}</div></div>`;
    const [g] = checkboxGroups(document.getElementById('f')!);
    expect(g.length).toBe(4);
    expect(radioGroupLabel(g)).toBe('Which industries have you worked in?');
  });

  it('ticks every option the answer names', () => {
    document.body.innerHTML = page();
    const [g] = checkboxGroups(document.body);
    const r = fillCheckboxGroup(g, 'IT/Tech | E-Commerce', (b) => radioOptionLabel(b, g));
    expect(r.ok).toBe(true);
    expect(g.filter((b) => b.checked).map((b) => radioOptionLabel(b, g))).toEqual(['E-Commerce', 'IT/Tech']);
    expect((document.getElementById('consent') as HTMLInputElement).checked).toBe(false);
  });

  it('splits answers on | , and new lines, keeping an option with a comma whole', () => {
    expect(splitChoices('IT/Tech, E-Commerce', INDUSTRIES)).toEqual(['IT/Tech', 'E-Commerce']);
    expect(splitChoices('IT/Tech\nE-Commerce', INDUSTRIES)).toEqual(['IT/Tech', 'E-Commerce']);
    expect(splitChoices('Sales, Lead Generation', ['Sales, Lead Generation', 'Other'])).toEqual(['Sales, Lead Generation']);
  });
});

describe('answers decided without the AI', () => {
  it('uses a stored fact for a choice question only when it is one of the choices', () => {
    const yesNo = { label: 'Do you have all the relevant skills?', inputType: 'radio', options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }] };
    expect(answerFitsOptions('TypeScript, JavaScript, Python, Kotlin, Swift', yesNo)).toBe(false);
    expect(answerFitsOptions('Yes', yesNo)).toBe(true);
    expect(answerFitsOptions('3 years', { label: 'Years of React experience', inputType: 'radio', options: ['0-2 years', '3-5 years', '6+ years'].map((x) => ({ value: x, label: x })) })).toBe(true);
    expect(answerFitsOptions('anything', { label: 'Name', inputType: 'text' })).toBe(true);
  });

  it('gives a start date of today + notice period, never in the past', () => {
    const now = new Date('2026-11-16T10:00:00Z');
    expect(startDateAnswer({ label: 'What is your earliest start date?', kind: 'input', inputType: 'text' }, '30 days', now)).toBe('2026-12-16');
    expect(startDateAnswer({ label: 'When can you start?', kind: 'input', inputType: 'date' }, '2 months', now)).toBe('2027-01-15');
    expect(startDateAnswer({ label: 'Available from', kind: 'input', inputType: 'date' }, undefined, now)).toBe('2026-12-16');
    expect(startDateAnswer({ label: 'Desired salary', kind: 'input', inputType: 'text' }, '30 days', now)).toBeNull();
    expect(startDateAnswer({ label: 'Earliest start date', kind: 'select', inputType: 'select', options: [{ value: 'a', label: 'Immediately' }] }, '30 days', now)).toBeNull();
  });
});

describe('typeahead suggestions', () => {
  it('picks the closest suggestion', () => {
    document.body.innerHTML = `<div role="listbox"><div role="option">Indore, Madhya Pradesh, India</div><div role="option">Indore Cantonment, India</div></div>`;
    const opts = [...document.querySelectorAll<HTMLElement>('[role=option]')];
    expect(bestSuggestion('Indore', opts)?.textContent).toBe('Indore, Madhya Pradesh, India');
    expect(bestSuggestion('Indore Cantonment', opts)?.textContent).toBe('Indore Cantonment, India');
  });
});
