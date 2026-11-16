import { describe, expect, it } from 'vitest';
import { radioGroupLabel, radioOptionLabel } from '@/lib/fields/radios';
import { fillRadioGroup } from '@/lib/fields/fill';

// LinkedIn Easy Apply, Nov 2026 (Smart Working): question in a <p> above a legend-less
// fieldset; every radio's aria-label is the question; option text in a <p> beside it.
const Q = 'Please respond truthfully. How many years of hands-on experience do you have developing and maintaining production applications using React Native?';
const opt = (id: string, text: string) =>
  `<div><div><div><input id="${id}" aria-label="${Q}" type="radio" name="radio-group-g"><label for="${id}"></label></div><div><p>${text}</p></div></div></div>`;
const live = `<div><p>${Q}*</p><fieldset aria-describedby="error-message-g" role="radiogroup"><div>
  ${opt('a', 'Less than 5 years — I have limited hands-on experience developing production React Native applications.')}
  ${opt('b', '5–7 years — I have solid experience developing and maintaining production React Native applications.')}
  ${opt('c', 'More than 7 years — I have extensive experience building, enhancing and maintaining production React Native applications.')}
</div></fieldset><p>This field is required</p></div>`;

describe('radio group labels', () => {
  it('reads LinkedIn questions without a legend, and each option from its row', () => {
    document.body.innerHTML = live;
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type=radio]')];
    expect(radioGroupLabel(radios)).toBe(Q);
    expect(radios.map((r) => radioOptionLabel(r, radios).split(' — ')[0])).toEqual(['Less than 5 years', '5–7 years', 'More than 7 years']);
  });

  it('picks the option the answer names, by its own text', () => {
    document.body.innerHTML = live;
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type=radio]')];
    const r = fillRadioGroup(radios, 'Less than 5 years — I have limited hands-on experience developing production React Native applications.', (x) => radioOptionLabel(x, radios), Q);
    expect(r.ok).toBe(true);
    expect(radios[0].checked).toBe(true);
  });

  it('maps a number of years onto the ranges', () => {
    for (const [answer, want] of [['3 years', 0], ['6', 1], ['8 years', 2]] as const) {
      document.body.innerHTML = live;
      const radios = [...document.querySelectorAll<HTMLInputElement>('input[type=radio]')];
      fillRadioGroup(radios, answer, (x) => radioOptionLabel(x, radios), Q);
      expect(radios.findIndex((r) => r.checked)).toBe(want);
    }
  });

  it('keeps legends and ordinary labels working', () => {
    document.body.innerHTML = `<fieldset><legend>Are you comfortable commuting?*</legend>
      <input type="radio" name="c" id="y" value="Yes"><label for="y">Yes</label>
      <input type="radio" name="c" id="n" value="No"><label for="n">No</label></fieldset>`;
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type=radio]')];
    expect(radioGroupLabel(radios)).toBe('Are you comfortable commuting?');
    expect(radios.map((r) => radioOptionLabel(r, radios))).toEqual(['Yes', 'No']);
  });
});
