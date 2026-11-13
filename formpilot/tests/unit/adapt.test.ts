import { describe, expect, it } from 'vitest';
import { adaptValue, describeExpectation, formatDate, optionRange, parseDate, parseDurationDays, parseMoney, parseYears, rangeOption, type FieldSpec } from '@/lib/fields/adapt';

const f = (q: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({ q: q.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim(), placeholder: '', type: 'text', inputMode: '', pattern: '', maxLength: -1, step: '', ...extra });

describe('reading answers', () => {
  it('money', () => {
    expect(parseMoney('10,75,000')).toEqual({ inr: 1075000, period: null });
    expect(parseMoney('10.75 LPA')).toEqual({ inr: 1075000, period: 'year' });
    expect(parseMoney('15 lakhs')?.inr).toBe(1500000);
    expect(parseMoney('1.2 Cr')?.inr).toBe(12000000);
    expect(parseMoney('1,25,000 INR per month')).toEqual({ inr: 125000, period: 'month' });
    expect(parseMoney('90k per month')).toEqual({ inr: 90000, period: 'month' });
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
    expect(adaptValue('30 days', f('Notice period'))).toBe('30 days'); // free text: unchanged
  });
  it('salary', () => {
    expect(adaptValue('10,75,000', f('Current CTC in lacs'))).toBe('10.75');
    expect(adaptValue('10,75,000', f('Current CTC (INR, annual, in lacs)'))).toBe('10.75');
    expect(adaptValue('10.75 LPA', f('Current CTC', { type: 'number' }))).toBe('1075000');
    expect(adaptValue('15,00,000', f('Expected CTC', { inputMode: 'numeric' }))).toBe('1500000');
    expect(adaptValue('15 LPA', f('Expected salary per month', { inputMode: 'numeric' }))).toBe('125000');
    expect(adaptValue('10,75,000', f('Current CTC'))).toBe('10,75,000'); // free text: unchanged
    expect(adaptValue('10,75,000', f('Current CTC (numbers only)'))).toBe('1075000');
  });
  it('experience', () => {
    expect(adaptValue('3+ years', f('How many years of experience do you have with React?', { type: 'number' }))).toBe('3');
    expect(adaptValue('3 years 6 months', f('Total experience in months'))).toBe('42');
    expect(adaptValue('3+ years', f('How many years of experience do you have with React?'))).toBe('3+ years');
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
