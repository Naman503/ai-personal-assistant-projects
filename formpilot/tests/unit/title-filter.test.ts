import { describe, expect, it } from 'vitest';
import { relevantWords, titleRelevant, titleSkipped } from '@/lib/queue';

const titles = ['React Native Developer', 'Mobile Engineer', 'Full Stack Engineer', 'Software Engineer', 'Python Developer', 'FastAPI Developer'];
const skip = 'Intern, Director, .Net, JAVA, QA, PHP, Golang, SAP, C#';

describe('job title filter (Naukri Recommended, 18 Nov)', () => {
  const rel = relevantWords(titles);
  it('keeps close relatives of your titles', () => {
    for (const t of ['React JS + Node JS Developer', 'React JS Developer', 'ReactJS Engineer', 'MERN Stack Developer', 'Node.js Developer', 'Front-End Engineer (React)', 'Django Developer'])
      expect(titleRelevant(t, rel), t).toBe(true);
  });
  it('still leaves out other stacks', () => {
    for (const t of ['Android Developer', 'Golang Developer', 'C++ Windows Programmer', 'iOS Developer']) expect(titleRelevant(t, rel), t).toBe(false);
  });
  it('skip words match whole words', () => {
    expect(titleSkipped('JavaScript Developer', skip)).toBe(false);
    expect(titleSkipped('Java Engineer (Mobile Server)', skip)).toBe(true);
    expect(titleSkipped('Java | GCP | SQL', skip)).toBe(true);
    expect(titleSkipped('Sapient - React Developer', skip)).toBe(false);
    expect(titleSkipped('SAP ABAP Consultant', skip)).toBe(true);
    expect(titleSkipped('.NET Core Developer', skip)).toBe(true);
    expect(titleSkipped('C# Developer', skip)).toBe(true);
    expect(titleSkipped('Senior QA Engineer', skip)).toBe(true);
    expect(titleSkipped('Product Engineer', 'Intern')).toBe(false);
    expect(titleSkipped('Software Engineer Intern', 'Intern')).toBe(true);
  });
});
