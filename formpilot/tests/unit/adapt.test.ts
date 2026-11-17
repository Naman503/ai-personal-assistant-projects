import { describe, expect, it } from 'vitest';
import { adaptValue, limitsFrom, repairValue, describeExpectation, formatDate, optionRange, parseDate, parseDurationDays, parseMoney, parseYears, rangeOption, type FieldSpec } from '@/lib/fields/adapt';

const f = (q: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ q: q.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim(), placeholder: '', type: 'text', inputMode: '', pattern: '', maxLength: -1, step: '', ...extra });

describe('reading answers', () => {
  it('money', () => {
    expect(parseMoney('10,75,000')).toEqual({ inr: 1075000, period: null, unitWritten: false });
    expect(parseMoney('10.75 LPA')).toEqual({ inr: 1075000, period: 'year', unitWritten: true });
    expect(parseMoney('15 lakhs')?.inr).toBe(1500000);
    expect(parseMoney('1.2 Cr')?.inr).toBe(12000000);
    expect(parseMoney('1,25,000 INR per month')).toEqual({ inr: 125000, period: 'month', unitWritten: false });
    expect(parseMoney('90k per month')).toEqual({ inr: 90000, period: 'month', unitWritten: true });
  });
  it('durations', () => {
    expect(parseDurationDays('30 days')).toBe(30);
    expect(parseDurationDays('1 month')).toBe(30);
    expect(parseDurationDays('2 weeks')).toBe(14);
    expect(parseDurationDays('Immediate joiner')).toBe(0);
    expect(parseDurationDays('30')).toBeNull();
  });
  it('years of experience', () => {
    expect(parseYears('3+ years')).toBe(3);
    expect(parseYears('3 years 6 months')).toBe(3.5);
    expect(parseYears('42 months')).toBe(3.5);
    expect(parseYears('3.5')).toBe(3.5);
  });
  it('dates, day first', () => {
    const iso = (d: Date | null) => d && formatDate(d, 'yyyy-mm-dd');
    expect(iso(parseDate('15/12/2026'))).toBe('2026-12-15');
    expect(iso(parseDate('2026-12-15'))).toBe('2026-12-15');
    expect(iso(parseDate('15 Dec 2026'))).toBe('2026-12-15');
    expect(iso(parseDate('December 15, 2026'))).toBe('2026-12-15');
    expect(iso(parseDate('151226'))).toBe('2026-12-15');
  });
});

describe('fitting an answer to a field', () => {
  it('notice period', () => {
    expect(adaptValue('30 days', f('Notice period', { inputMode: 'numeric' }))).toBe('30');
    expect(adaptValue('30 days', f('Notice period (in days)'))).toBe('30');
    expect(adaptValue('30 days', f('Notice period in months'))).toBe('1');
    expect(adaptValue('Immediate', f('How soon can you join? (days)'))).toBe('0');
    expect(adaptValue('30 days', f('Notice period'))).toBe('30'); // LinkedIn rejects "30 Days" in a plain text box
  });
  it('salary', () => {
    expect(adaptValue('10,75,000', f('Current CTC in lacs'))).toBe('10.75');
    expect(adaptValue('10,75,000', f('Current CTC (INR, annual, in lacs)'))).toBe('10.75');
    expect(adaptValue('10.75 LPA', f('Current CTC', { type: 'number' }))).toBe('1075000');
    expect(adaptValue('15,00,000', f('Expected CTC', { inputMode: 'numeric' }))).toBe('1500000');
    expect(adaptValue('15 LPA', f('Expected salary per month', { inputMode: 'numeric' }))).toBe('125000');
    expect(adaptValue('10,75,000', f('Current CTC'))).toBe('1075000'); // LinkedIn rejects "10,75,000"
    expect(adaptValue('10,75,000', f('Current CTC (numbers only)'))).toBe('1075000');
  });
  it('experience', () => {
    expect(adaptValue('3+ years', f('How many years of experience do you have with React?', { type: 'number' }))).toBe('3');
    expect(adaptValue('3 years 6 months', f('Total experience in months'))).toBe('42');
    expect(adaptValue('3+ years', f('How many years of experience do you have with React?'))).toBe('3');
  });
  it('dates', () => {
    expect(adaptValue('15/12/2026', f('Last working day', { type: 'date' }))).toBe('2026-12-15');
    expect(adaptValue('15 Dec 2026', f('Mention your official LWD in DDMMYY format'))).toBe('151226');
    expect(adaptValue('2026-12-15', f('Date of joining', { placeholder: 'DD/MM/YYYY' }))).toBe('15/12/2026');
  });
  it('phone', () => {
    expect(adaptValue('+91 62645 79927', f('Mobile number', { type: 'tel', maxLength: 10 }))).toBe('6264579927');
    expect(adaptValue('+91 62645 79927', f('Mobile number', { type: 'tel' }))).toBe('+91 62645 79927');
  });
  it('generic numbers-only fields', () => {
    expect(adaptValue('85%', f('Graduation percentage', { inputMode: 'decimal' }))).toBe('85');
    expect(adaptValue('About 12 people', f('Team size', { pattern: '[0-9]*' }))).toBe('12');
    expect(adaptValue('Bengaluru', f('City'))).toBe('Bengaluru');
  });
});

describe('choosing a dropdown / radio option by range', () => {
  it('reads option ranges', () => {
    expect(optionRange('15 days or less', 'days')).toEqual({ lo: 0, hi: 15 });
    expect(optionRange('1 Month', 'days')).toEqual({ lo: 30, hi: 30 });
    expect(optionRange('2-3 months', 'days')).toEqual({ lo: 60, hi: 90 });
    expect(optionRange('Immediate', 'days')).toEqual({ lo: 0, hi: 0 });
    expect(optionRange('5+ years', 'years')?.hi).toBe(Infinity);
    expect(optionRange('5 - 10 LPA', 'inr')).toEqual({ lo: 500000, hi: 1000000 });
  });
  it('picks the option that contains the answer', () => {
    expect(rangeOption('30 days', ['Immediate', '15 days or less', '1 Month', '2 Months', '3 Months', 'More than 3 Months'], 'Notice period')).toBe(2);
    expect(rangeOption('3+ years', ['0-1 years', '1-3 years', '3-5 years', '5+ years'], 'Total experience')).toBe(2);
    expect(rangeOption('10,75,000', ['0-5 Lakhs', '5-10 Lakhs', '10-15 Lakhs', '15+ Lakhs'], 'Current CTC')).toBe(2);
    expect(rangeOption('Yes', ['Yes', 'No'], 'Willing to relocate?')).toBe(-1);
  });
});

describe('prompt hints', () => {
  it('tells the AI the shape it needs', () => {
    expect(describeExpectation(f('Current CTC in lacs', { inputMode: 'decimal' }))).toContain('lakhs');
    expect(describeExpectation(f('Notice period (days)', { inputMode: 'numeric' }))).toContain('whole number');
    expect(describeExpectation(f('LWD', { placeholder: 'DD/MM/YYYY' }))).toContain('DD/MM/YYYY');
  });
});

describe('live LinkedIn salary / notice boxes and "Invalid input" repair', () => {
  it('gives plain numbers, in lakhs only when the question says LPA / lakhs', () => {
    expect(adaptValue('15,00,000', f("What's your Expected CTC ?"))).toBe('1500000');
    expect(adaptValue('15 LPA', f("What's your Expected CTC ?"))).toBe('1500000');
    expect(adaptValue('15', f("What's your Expected CTC ?"))).toBe('1500000'); // a bare 15 is 15 lakh
    expect(adaptValue('15,00,000', f('Expected CTC (in LPA)'))).toBe('15');
    expect(adaptValue('10.75 LPA', f('Current salary in lakhs per annum'))).toBe('10.75');
    expect(adaptValue('15', f('Expected CTC in LPA'))).toBe('15'); // already lakhs, not 0.00015
    expect(adaptValue('30 Days', f('Notice Period ?'))).toBe('30');
    expect(adaptValue('Immediate', f('Notice period'))).toBe('0');
    expect(adaptValue('50,000', f('Monthly salary expectation'))).toBe('50000');
  });

  it('reads limits from validation messages', () => {
    expect(limitsFrom('Enter a whole number between 0 and 99')).toEqual({ whole: true, min: 0, max: 99 });
    expect(limitsFrom('Enter a decimal number larger than 0.0')).toEqual({ whole: false, min: 0 });
    expect(limitsFrom('Enter a decimal number larger than 0.0 and smaller than 9,99,99,999').max).toBe(99999999);
    expect(limitsFrom('Invalid input')).toEqual({ whole: false });
  });

  it('repairs a rejected value: bare number first, then rescales to fit a stated range', () => {
    const ctc = f("What's your Expected CTC ?");
    expect(repairValue('15,00,000', 'Invalid input', ctc)).toBe('1500000');
    expect(repairValue('1500000', 'Invalid input', ctc, 1)).toBe('15');
    expect(repairValue('1500000', 'Enter a whole number between 0 and 99', ctc)).toBe('15');
    expect(repairValue('10.75', 'Enter a whole number between 0 and 99', f('Current CTC'))).toBe('11');
    expect(repairValue('30 Days', 'Invalid input', f('Notice Period ?'))).toBe('30');
    expect(repairValue('90', 'Enter a whole number between 0 and 6', f('Notice period'))).toBe('3');
    expect(repairValue('3+ years', 'Enter a decimal number larger than 0.0', f('Years of experience with React Native'))).toBe('3');
    expect(repairValue('15', 'Enter a whole number between 0 and 99', ctc)).toBe(null); // already fits: leave it to you
  });
});

describe('salary answers seen going wrong live (16–17 Nov)', () => {
  it('a monthly amount for a monthly question is not divided by 12 again', () => {
    expect(adaptValue('125000', f('What is your expected monthly salary in INR?'))).toBe('125000');
    expect(adaptValue('15,00,000', f('What is your expected monthly salary in INR?'))).toBe('125000');
    expect(adaptValue('1000000', f('What is your current monthly salary in INR?'))).toBe('83333');
  });
  it('"in INR" means rupees even when the job quotes its range in LPA', () => {
    expect(adaptValue('41667', f('Our monthly salary for this role is INR 25,000 to INR 41,667 (3 to 5 LPA). What monthly salary in INR, within this range, would you accept?'))).toBe('41667');
    expect(adaptValue('15 LPA', f('What is your expected annual fixed compensation (in INR lakhs)?'))).toBe('15');
  });
  it('"15,00,000 INR per month" is a yearly figure', () => {
    expect(adaptValue('1,500,000 INR per month', f('Desired salary per month (in your local currency):'))).toBe('125000');
  });
  it('USD boxes get dollars', () => {
    expect(adaptValue('10,75,000', f('Current Monthly Salary/Compensation (USD)'))).toBe('1018');
    expect(adaptValue('125000', f('Expected Monthly Salary/Compensation (USD)'))).toBe('1420');
  });
});
