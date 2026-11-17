import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, parseReview, usableFix, type ReviewItem } from '@/lib/engine/review';

describe('answer review', () => {
  const num: ReviewItem = { id: 'f0', question: 'Total years of experience', answer: '3.5 years in React Native', kind: 'number' };
  const pick: ReviewItem = { id: 'r0', question: 'Notice period', answer: '2 months', kind: 'choice', options: ['Immediate', '30 days', '60 days'] };
  it('parses fixes from the model', () => {
    expect(parseReview('```json\n{"items":[{"id":"f0","ok":false,"fix":"3","why":"number only"},{"id":"r0","ok":true}]}\n```')).toEqual([
      { id: 'f0', ok: false, fix: '3', why: 'number only' },
      { id: 'r0', ok: true, fix: undefined, why: undefined },
    ]);
    expect(parseReview('nonsense')).toEqual([]);
  });
  it('only uses fixes that fit the field', () => {
    expect(usableFix(num, { id: 'f0', ok: false, fix: '3' })).toBe('3');
    expect(usableFix(num, { id: 'f0', ok: false, fix: 'three' })).toBeNull();
    expect(usableFix(pick, { id: 'r0', ok: false, fix: '30 Days' })).toBe('30 days');
    expect(usableFix(pick, { id: 'r0', ok: false, fix: '45 days' })).toBeNull();
    expect(usableFix(pick, { id: 'r0', ok: true, fix: '30 days' })).toBeNull();
  });
  it('puts every answer and its options in the prompt', () => {
    const p = buildReviewPrompt([num, pick], 'React Native Engineer at Plazza', 'Notice: 30 days', 'resume text');
    expect(p).toContain('"Total years of experience"');
    expect(p).toContain('options: "Immediate", "30 days", "60 days"');
    expect(p).toContain('Notice: 30 days');
  });
});
