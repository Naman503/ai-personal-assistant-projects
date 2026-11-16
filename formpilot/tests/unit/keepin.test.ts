import { describe, expect, it } from 'vitest';
import { experienceAnswer, keepInAnswer } from '@/lib/fields/answers';
import { relevantWords, titleRelevant } from '@/lib/queue';

const yn = [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }];

describe('answers that keep you in the running', () => {
  it('years of experience you never stated: 3, never 0', () => {
    expect(experienceAnswer({ label: 'How many years of work experience do you have with Flutter?' }, '0')).toBe('3');
    expect(experienceAnswer({ label: 'How many years of work experience do you have with Windows?' }, '')).toBe('3');
    expect(experienceAnswer({ label: 'How many years of Administrative experience do you currently have?' }, 'N/A')).toBe('3');
    expect(experienceAnswer({ label: 'Years of experience in Kotlin', options: [{ value: '0-1', label: '0-1 years' }, { value: '2-4', label: '2-4 years' }] }, '')).toBe('3 years');
    // A number from your resume stays.
    expect(experienceAnswer({ label: 'How many years of experience do you have in React Native?' }, '4')).toBeNull();
    expect(experienceAnswer({ label: 'What is your current CTC?' }, '0')).toBeNull();
  });

  it('willingness questions: Yes', () => {
    expect(keepInAnswer({ label: "Are you comfortable commuting to this job's location?", options: yn })).toBe('Yes');
    expect(keepInAnswer({ label: 'Are you comfortable working in an onsite setting?', options: yn })).toBe('Yes');
    expect(keepInAnswer({ label: 'Are you willing to relocate to Bengaluru?', options: yn })).toBe('Yes');
    expect(keepInAnswer({ label: 'Are you open to working night shifts?', options: yn })).toBe('Yes');
    // Facts about you are not willingness questions.
    expect(keepInAnswer({ label: 'Are you in Delhi/NCR Region ?', options: yn })).toBeNull();
    expect(keepInAnswer({ label: 'Do you have a valid work visa?', options: yn })).toBeNull();
  });

  it('skips jobs that are not your kind (Operations Manager on a React Native search)', () => {
    const rel = relevantWords(['React Native Developer', 'React Native Engineer', 'Mobile Engineer', 'Full Stack Engineer', 'Software Engineer']);
    expect(rel).toEqual(['react', 'native', 'mobile', 'full', 'stack', 'software']);
    expect(titleRelevant('Operations Manager', rel)).toBe(false);
    expect(titleRelevant('Flutter/Dart Developer (Cross-Platform)', rel)).toBe(false);
    expect(titleRelevant('Software Engineer (React Native+AI)', rel)).toBe(true);
    expect(titleRelevant('Frontend Developer (React.js & React Native)', rel)).toBe(true);
    expect(titleRelevant('Mobile Application Developer', rel)).toBe(true);
    expect(titleRelevant('Anything', [])).toBe(true);
  });
});
