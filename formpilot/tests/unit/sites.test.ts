import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cutshortJobs, cutshortSearchUrl, expMinOf, founditJobs, founditSearchUrl, jobPageState, naukriJobs, naukriSearchUrl, platformOf, sentNotice, sitePushback } from '@/lib/sites';

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

  it('on Cutshort job pages, presses "Apply to this job", never a similar job\'s "Apply now"', () => {
    document.body.innerHTML = '<button>Apply to this job</button><section><button>Apply now</button></section>';
    expect(jobPageState('cutshort', document).apply?.textContent).toBe('Apply to this job');
    document.body.innerHTML = '<section><button>Apply now</button></section>';
    expect(jobPageState('cutshort', document).apply).toBeNull();
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

describe('Foundit', () => {
  const load = (file: string) => {
    document.body.innerHTML = readFileSync(`tests/fixtures/${file}`, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
    return document;
  };
  it('reads the search cards: title, company, years, Quick Apply or not', () => {
    const jobs = founditJobs(load('foundit-search.html'));
    expect(jobs.map((j) => [j.title, j.company, j.expMin, j.quick])).toEqual([
      ['React Native Developer', 'Valuelabs', 2, true],
      ['React Native Developer', 'Flexiple', 4, false],
      ['Senior React Native Developer', 'BigCo', 9, true],
    ]);
    expect(jobs[0].url).toMatch(/foundit-job\.html\?id=101$|foundit\.in\/job\/101$/);
  });
  it('presses only the header Quick Apply, never a similar job\'s Apply Now', () => {
    const doc = load('foundit-job.html');
    const st = jobPageState('foundit', doc);
    expect(st.apply?.closest('#jdPageHeader')).toBeTruthy();
    expect(st.external).toBe(false);
    doc.querySelector('#jdPageHeader #applyBtn')!.textContent = 'Apply Now';
    expect(jobPageState('foundit', doc)).toMatchObject({ apply: null, external: true });
    doc.querySelector('#jdPageHeader #applyBtn')!.textContent = 'Applied';
    expect(jobPageState('foundit', doc).applied).toBe(true);
    expect(sentNotice('foundit', doc, 'https://www.foundit.in/job/101')).toBe(true);
  });
  it('knows the site and the search link', () => {
    expect(platformOf('https://www.foundit.in/srp/results?query=x')).toBe('foundit');
    expect(founditSearchUrl('React Native Developer')).toBe('https://www.foundit.in/srp/results?query=React+Native+Developer&locations=India');
  });
});
