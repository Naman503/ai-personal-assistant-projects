import { describe, expect, it } from 'vitest';
import { canonicalJobUrl, extractJob, isConfirmation, looksLikeSubmit, sourceForHost } from '@/lib/job';
import { classifyField } from '@/lib/fields/classify';
import { experienceSubject } from '@/lib/engine/history';

describe('job pages', () => {
  it('canonicalises LinkedIn job URLs', () => {
    expect(canonicalJobUrl('https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=react')).toBe('https://www.linkedin.com/jobs/view/4012345678/');
    expect(canonicalJobUrl('https://www.linkedin.com/jobs/view/4012345678/?refId=abc')).toBe('https://www.linkedin.com/jobs/view/4012345678/');
    expect(canonicalJobUrl('https://jobs.lever.co/acme/123?lever-source=x#apply')).toBe('https://jobs.lever.co/acme/123');
  });

  it('names the source from the host', () => {
    expect(sourceForHost('www.naukri.com')).toBe('Naukri');
    expect(sourceForHost('in.linkedin.com')).toBe('LinkedIn');
    expect(sourceForHost('boards.greenhouse.io')).toBe('Company site');
  });

  it('reads a JSON-LD JobPosting without running its HTML', () => {
    document.head.innerHTML = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Senior Mobile Engineer',
      hiringOrganization: { name: 'Acme' },
      jobLocation: { address: { addressLocality: 'Bengaluru', addressRegion: 'KA' } },
      description: '<p>Build the app.</p><img src=x onerror="window.__pwned=1"><ul><li>3+ years</li></ul>',
    })}</script>`;
    document.body.innerHTML = '<h1>ignored</h1>';
    const job = extractJob(document, 'https://careers.acme.com/jobs/42?utm=1');
    expect(job.role).toBe('Senior Mobile Engineer');
    expect(job.company).toBe('Acme');
    expect(job.location).toBe('Bengaluru, KA');
    expect(job.description).toContain('Build the app.');
    expect(job.url).toBe('https://careers.acme.com/jobs/42');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('falls back to the heading and site name', () => {
    document.head.innerHTML = '<meta property="og:site_name" content="Beta Labs">';
    document.body.innerHTML = '<main><h1>Backend Engineer</h1></main>';
    const job = extractJob(document, 'https://beta.example/careers/backend');
    expect(job.role).toBe('Backend Engineer');
    expect(job.company).toBe('Beta Labs');
  });
});

describe('application confirmation', () => {
  it.each([
    'Your application was sent to Acme!',
    'Application submitted',
    'You have successfully applied to Senior Engineer',
    'Applied successfully',
    'Thank you for applying to Beta Labs.',
    "We've received your application",
  ])('recognises "%s"', (t) => expect(isConfirmation(t)).toBe(true));

  it.each(['Submit application', 'Apply to Acme', 'Review your application', 'Application deadline: 30 Nov'])('ignores "%s"', (t) => expect(isConfirmation(t)).toBe(false));

  it('arms only on buttons that send an application', () => {
    expect(looksLikeSubmit('Submit application')).toBe(true);
    expect(looksLikeSubmit('Apply')).toBe(true); // Naukri's one-click apply
    expect(looksLikeSubmit('Easy Apply')).toBe(false);
    expect(looksLikeSubmit('Apply now')).toBe(false);
    expect(looksLikeSubmit('Next')).toBe(false);
  });
});

describe('fixes from real use', () => {
  it('tells expected CTC from current CTC', () => {
    expect(classifyField({ label: 'Expected CTC' })).toBe('salary-expected');
    expect(classifyField({ label: 'What is your expected CTC?' })).toBe('salary-expected');
    expect(classifyField({ label: 'Please enter your expected CTC in INR' })).toBe('salary-expected');
    expect(classifyField({ label: 'Current CTC' })).toBe('salary-current');
    expect(classifyField({ label: 'CTC' })).toBe('salary-current');
  });

  it('keeps "years of experience in X" answers per skill', () => {
    expect(experienceSubject('how many years of experience do you have in golang')).toBe('golang');
    expect(experienceSubject('how many years of experience do you have in react')).toBe('react');
    expect(experienceSubject('how many years of work experience do you have with react native')).toBe('react native');
    expect(experienceSubject('total years of experience')).toBe('');
  });
});

describe('confirmation inside shadow roots', () => {
  it('reads text from open shadow roots and counts new confirmations', async () => {
    const { deepText, confirmationCount } = await import('@/lib/job');
    document.body.innerHTML = '<div id="h"></div><p>Easy Apply</p>';
    const root = document.getElementById('h')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<p>Your application was sent to Beta!</p>';
    expect(deepText()).toContain('Your application was sent');
    expect(confirmationCount(deepText())).toBe(1);
    expect(confirmationCount('Applied 2 minutes ago')).toBe(1);
  });
});

describe('LinkedIn company when its classes change', () => {
  it('reads the company from the tab title', () => {
    document.head.innerHTML = '';
    document.title = '(3) React Native Developer | Recro | LinkedIn';
    document.body.innerHTML = '<main><h1>React Native Developer</h1></main>';
    const job = extractJob(document, 'https://www.linkedin.com/jobs/search/?currentJobId=4486569938');
    expect(job.company).toBe('Recro');
    expect(job.url).toBe('https://www.linkedin.com/jobs/view/4486569938/');
  });
  it('reads company and location from a public job page title', () => {
    document.title = 'React Native Developer at Collegedunia — Gurugram, Haryana, India | LinkedIn Jobs';
    document.body.innerHTML = '<main><h1>React Native Developer</h1></main>';
    const job = extractJob(document, 'https://www.linkedin.com/jobs/view/4480026440/');
    expect(job.company).toBe('Collegedunia');
    expect(job.location).toBe('Gurugram, Haryana, India');
  });
  it('falls back to the company link', () => {
    document.title = 'Jobs';
    document.body.innerHTML = '<main><h1>Sr Mobile Developer</h1><a href="https://www.linkedin.com/company/blend/life/">Blend</a></main>';
    expect(extractJob(document, 'https://www.linkedin.com/jobs/view/4490348204/').company).toBe('Blend');
  });
});
