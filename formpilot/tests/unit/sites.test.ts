import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cutshortJobs, cutshortSearchUrl, expMinOf, jobPageState, naukriJobs, naukriSearchUrl, sentNotice, sitePushback } from '@/lib/sites';

const fixture = (f: string) => readFileSync(resolve(__dirname, '../fixtures', f), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

describe('Naukri and Cutshort pages', () => {
  it('builds the searches', () => {
    const n = new URL(naukriSearchUrl('React Native Developer', 1));
    expect(n.pathname).toBe('/react-native-developer-jobs');
    expect(Object.fromEntries(n.searchParams)).toEqual({ k: 'React Native Developer', jobAge: '1', experience: '3' });
    expect(cutshortSearchUrl('React Native Developer')).toBe('https://cutshort.io/search-jobs?free_text=React+Native+Developer');
  });

  it('reads experience ranges', () => {
    expect(expMinOf('4-6 Yrs')).toBe(4);
    expect(expMinOf(' 1 - 3 yrs')).toBe(1);
    expect(expMinOf('5+ years')).toBe(5);
    expect(expMinOf('Remote only')).toBeUndefined();
  });

  it('reads the Naukri job list (live markup)', () => {
    document.body.innerHTML = fixture('naukri-search.html');
    const jobs = naukriJobs(document);
    expect(jobs.map((j) => [j.title, j.company, j.expMin])).toEqual([
      ['React Native Developer - Wissen', 'Wissen Technology', 2],
      ['Operations Manager', 'Acme', 1],
      ['Senior Mobile Engineer', 'BigCo', 8],
    ]);
    expect(jobs[0].url).toContain('/naukri-job.html?id=1'.split('?')[0]);
  });

  it('reads the Cutshort job list (live markup)', () => {
    document.body.innerHTML = fixture('cutshort-search.html');
    const jobs = cutshortJobs(document);
    expect(jobs.map((j) => [j.title, j.company, j.expMin, j.applied])).toEqual([
      ['Junior React Native Developer', 'Quixta', 1, false],
      ['Backend Developer (Java)', 'Xco', 2, false],
    ]);
  });

  it('knows the Naukri job page states', () => {
    document.body.innerHTML = '<button id="apply-button">Apply</button>';
    expect(jobPageState('naukri', document).apply).not.toBeNull();
    document.body.innerHTML = '<button id="apply-button">Applied</button>';
    expect(jobPageState('naukri', document)).toMatchObject({ apply: null, applied: true });
    document.body.innerHTML = '<button id="company-site-button">Apply on company site</button>';
    expect(jobPageState('naukri', document)).toMatchObject({ apply: null, external: true });
    document.body.innerHTML = '<p>You have successfully applied to this job.</p>';
    expect(sentNotice('naukri', document, 'https://www.naukri.com/job-listings-x')).toBe(true);
    expect(sentNotice('naukri', document, 'https://www.naukri.com/myapply/saveApply?x=1')).toBe(true);
  });

  it('stops on sign-in and limits', () => {
    document.body.innerHTML = '<p>Jobs</p>';
    expect(sitePushback('naukri', document, 'https://www.naukri.com/nlogin/login')).toMatch(/sign in/);
    document.body.innerHTML = '<p>You have reached your daily apply limit.</p>';
    expect(sitePushback('naukri', document, 'https://www.naukri.com/job-listings-x')).toMatch(/limit/);
    document.body.innerHTML = '<p>React Native Developer</p>';
    expect(sitePushback('cutshort', document, 'https://cutshort.io/job/x')).toBe('');
  });
});
