import { describe, expect, it } from 'vitest';
import { dateBlocks, parseWorkHistory, plan, spanFor } from '@/lib/fields/workdates';

// The user's resume as pdf.js extracts it (Nov 2026): title, company, "years | city".
const RESUME = `Naman Pathak
Software Engineer | Mobile & Full Stack
Eazeebox
2025 – Present | Bengaluru, India
•Own the development of the company's core B2B e-commerce app
Core Engineer
Metafic
2023 – 2025 | Indore, India
•Smart Air (Bangladesh): led the admin panel
Bachelor of Technology - Computer Science
Indore Institute of Science and Technology
2020 – 2024 | Indore, India
Intern, Acme Labs, Jun 2022 - Aug 2022`;

const monthOpts = `<option value="">Month</option>${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}`;
const yearOpts = `<option value="">Year</option>${Array.from({ length: 30 }, (_, i) => `<option value="${2036 - i}">${2036 - i}</option>`).join('')}`;
// Mirrors LinkedIn's Edit experience block: unlabeled dropdowns under "From" / "To".
const block = (company: string) => `<div class="exp"><div>Edit experience</div>
  <div><label for="t-${company}">Your title*</label><input type="text" id="t-${company}" value="Software Engineer"></div>
  <div><label for="c-${company}">Company</label><input type="text" id="c-${company}" value="${company}"></div>
  <div><div>Dates of employment</div>
    <div><div>From</div><div><div><select>${monthOpts}</select><p>This field is required</p></div><div><select>${yearOpts}</select><p>This field is required</p></div></div></div>
    <div><input type="checkbox" id="cur-${company}"><label for="cur-${company}">I currently work here</label></div>
    <div><div>To</div><div><div><select>${monthOpts}</select></div><div><select>${yearOpts}</select></div></div></div>
  </div></div>`;

describe('employment dates', () => {
  it('reads date ranges and the company lines above them from the resume', () => {
    const spans = parseWorkHistory(RESUME);
    expect(spans.map((s) => [s.from, s.to])).toEqual([
      [{ y: 2025, m: undefined }, 'present'],
      [{ y: 2023, m: undefined }, { y: 2025, m: undefined }],
      [{ y: 2020, m: undefined }, { y: 2024, m: undefined }],
      [{ y: 2022, m: 6 }, { y: 2022, m: 8 }],
    ]);
    expect(spanFor('Metafic', spans)?.from.y).toBe(2023);
    expect(spanFor('Eazeebox Technologies Pvt Ltd', spans)?.to).toBe('present');
    expect(spanFor('Acme Labs', spans)?.from).toEqual({ y: 2022, m: 6 });
    expect(spanFor('Google', spans)).toBe(null);
  });

  it("finds LinkedIn's From/To Month and Year dropdowns and the company they belong to", () => {
    document.body.innerHTML = `<dialog open>${block('Metafic')}${block('Eazeebox')}</dialog>`;
    const bs = dateBlocks(document.querySelector('dialog')!);
    expect(bs.map((b) => [b.company, b.groups.map((g) => [g.role, !!g.month]), !!b.current])).toEqual([
      ['Metafic', [['from', true], ['to', true]], true],
      ['Eazeebox', [['from', true], ['to', true]], true],
    ]);
  });

  it('plans years from the resume and months only when known (remembered wins), never guessing', () => {
    document.body.innerHTML = `<dialog open>${block('Metafic')}</dialog>`;
    const [b] = dateBlocks(document.querySelector('dialog')!);
    const spans = parseWorkHistory(RESUME);
    expect(plan(b, spans, {})).toEqual({ from: { y: 2023, m: undefined }, to: { y: 2025, m: undefined }, matched: true });
    expect(plan(b, spans, { metafic: { from: { y: 2023, m: 6 }, to: { y: 2025, m: 3 } } })).toEqual({ from: { y: 2023, m: 6 }, to: { y: 2025, m: 3 }, matched: true });
    // Remembered year only: the resume's month for that same year fills in (none here).
    expect(plan(b, spans, { metafic: { from: { y: 2023 } } }).from).toEqual({ y: 2023, m: undefined });
    document.body.innerHTML = `<dialog open>${block('Eazeebox')}</dialog>`;
    expect(plan(dateBlocks(document.querySelector('dialog')!)[0], spans, {}).to).toBe('present');
  });
});
