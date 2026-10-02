import { describe, expect, it } from 'vitest';
import { classifyField, isFactual, isSensitive, splitIdent } from '@/lib/fields/classify';

describe('classifyField', () => {
  it('prefers input type and autocomplete tokens', () => {
    expect(classifyField({ inputType: 'email', label: 'Contact' })).toBe('email');
    expect(classifyField({ autocomplete: 'shipping given-name', label: 'xyz' })).toBe('given-name');
    expect(classifyField({ autocomplete: 'section-a billing postal-code' })).toBe('postal-code');
    expect(classifyField({ inputType: 'password', label: 'Email' })).toBe('password');
  });

  it.each([
    ['First Name *', 'given-name'],
    ['Last name', 'family-name'],
    ['Full name', 'name'],
    ['Mobile number', 'tel'],
    ['LinkedIn Profile', 'linkedin'],
    ['GitHub URL', 'github'],
    ['Current CTC (LPA)', 'salary-current'],
    ['Expected salary', 'salary-expected'],
    ['Notice period', 'notice-period'],
    ['Years of experience', 'experience-years'],
    ['Cover letter', 'cover-letter'],
    ['Tell us about yourself', 'summary'],
    ['Company name', 'organization'],
    ['ZIP / Postal code', 'postal-code'],
    ['PIN code', 'postal-code'],
  ])('label %j → %s', (label, type) => {
    expect(classifyField({ label })).toBe(type);
  });

  it('detects sensitive fields', () => {
    for (const label of ['Card number', 'CVV', 'Enter OTP', 'One-time code', 'Password', 'ATM PIN', 'Enter the captcha', 'IBAN', 'Aadhaar number']) {
      expect(isSensitive(classifyField({ label })), label).toBe(true);
    }
    expect(isSensitive(classifyField({ label: 'PIN code' }))).toBe(false);
  });

  it('falls back to name/id when the label is empty', () => {
    expect(classifyField({ name: 'firstName' })).toBe('given-name');
    expect(classifyField({ htmlId: 'user_email_address' })).toBe('email');
  });

  it('does not mistake long questions for short factual fields', () => {
    expect(classifyField({ label: 'Please state in a few sentences why you are a good fit for this role' })).toBe('text');
    expect(classifyField({ label: 'Why do you want to work at our company and what motivates you' })).toBe('motivation');
  });

  it('helpers', () => {
    expect(splitIdent('firstName_or-last')).toBe('first Name or last');
    expect(isFactual('email')).toBe(true);
    expect(isFactual('cover-letter')).toBe(false);
  });
});
