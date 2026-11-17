import { describe, expect, it } from 'vitest';
import { experienceAnswer, joinDaysAnswer, knowsSkill, notServingNotice } from '@/lib/fields/answers';

// Real questions from the user's applications (audit of 17 Nov).
const SKILLS = 'TypeScript, JavaScript, Python, Java, C++, C, Kotlin, React, React Native, Expo, Redux, Next.js, FastAPI, Django, Node.js, Express.js, AWS, Docker, PostgreSQL, MongoDB, LangChain, Swift, Android, MySQL, RAG';
const yrs = (label: string, answer = '3', options?: string[]) => experienceAnswer({ label, options: options?.map((o) => ({ value: o, label: o })) } as never, answer, SKILLS);

describe('years of experience follow the resume', () => {
  it.each([
    'How many years of work experience do you have with Ruby on Rails?',
    'How many years of work experience do you have with C#?',
    'How many years of work experience do you have with .NET Framework?',
    'How many years of work experience do you have with PHP?',
    'How many years of work experience do you have with Laravel?',
    'How many years of work experience do you have with Azure Databricks?',
    'How many years of work experience do you have with ATE, data acquisition using NI cDAQ and Beckhoff ?',
  ])('0 for a skill not on the resume: %s', (q) => expect(yrs(q)).toBe('0'));

  it.each([
    ['How many years of work experience do you have with Python (Programming Language)?', '3'],
    ['How many years of work experience do you have with React Native?', '3'],
    ['How many years of work experience do you have with React.js?', '3'],
    ['How many years of work experience do you have with PostgreSQL?', '3'],
    ['How many years of work experience do you have with Django?', '2'],
    ['How many years of work experience do you have with Docker?', '3'],
    ['How many years of work experience do you have with "cloud"?', '3'],
    ['How many years of work experience do you have with databases?', '3'],
    ['How many years of work experience do you have with Retrieval-Augmented Generation (RAG)?', '2'],
  ])('keeps the answer for a skill you have: %s', (q, a) => expect(yrs(q, a)).toBeNull());

  it('unknown years for a skill you have, and overall experience, are 3', () => {
    expect(yrs('How many years of work experience do you have with Node.js?', '')).toBe('3');
    expect(yrs('How many years of professional software engineering experience do you have?', '0')).toBe('3');
    expect(yrs('What is your total years of work experience?', '')).toBe('3');
  });
  it('picks the "none" option for a skill you lack', () => {
    expect(yrs('How many years of experience do you have with Golang?', '', ['0', '1-2 years', '3-5 years'])).toBe('0');
  });
  it('knowsSkill handles aliases', () => {
    expect(knowsSkill('react.js or next.js', SKILLS)).toBe(true);
    expect(knowsSkill('ruby', SKILLS)).toBe(false);
  });
});

describe('notice and joining', () => {
  it('joining days are the notice period', () => {
    const j = (label: string) => joinDaysAnswer({ label } as never, '30 days');
    expect(j('In how many days can you join us?')).toBe('30');
    expect(j('If offered the role, within how many days will you be able to join?')).toBe('30');
    expect(j('We are looking for immediate joiners. What is your notice period?')).toBe('30');
  });
  it('last working day stays empty when not serving notice', () => {
    expect(notServingNotice({ label: 'If serving, when is your last working day?' })).toBe(true);
    expect(notServingNotice({ label: 'If you are serving notice, what will be your official last working day?' })).toBe(true);
    expect(notServingNotice({ label: 'What is your notice period?' })).toBe(false);
  });
});
