import { describe, expect, it } from 'vitest';
import { hiristJobs, sentNotice, instahyreJobs, openToIndia, platformOf, searchUrlFor, uplersJobs, wellfoundJobs, ycJobs } from '@/lib/sites';
import { himalayasLocation, parseWwr } from '@/lib/sitepilot/feeds';
import { fitting } from '@/lib/sitepilot/boards';
import { BOARD_JOB, onHop } from '@/lib/sitepilot/runner';

const html = (s: string) => {
  const d = document.createElement('div');
  d.innerHTML = s;
  return d;
};

// Shapes read live on 17 Nov 2026 (contents shortened).
const WELLFOUND = `<div data-test="StartupResult"><a href="/company/cipherschools"><h2>CipherSchools</h2></a>
<div class="styles_jobListingList__YGDNO"><div class="styles_component__dBicB"><div><header><div><div class="styles_badge__44SWu">Apply on Wellfound</div></div></header>
<div class="styles_component__Ey28k"><a class="styles_jobLink__US40J" href="/jobs/5094766-mern-stack-developer"><div><div><span class="styles_title__xpQDw">MERN Stack Developer</span></div>
<span><span class="styles_locations__HHbZs"><span class="styles_location__O9Z62">Remote only</span>India</span><span class="styles_compensation__3JnvU">₹8L – ₹12L</span></span></div></a></div></div>
<div><header><div><div class="styles_badge__44SWu">Apply on company website</div></div></header><div class="styles_component__Ey28k"><a class="styles_jobLink__US40J" href="/jobs/42-react-native-engineer"><span class="styles_title__x">React Native Engineer</span><span class="styles_location__x">In office</span></a></div></div></div></div>`;

const YC = `<div><a href="/companies/spine"><span>Spine</span></a><a href="/companies/spine/website"></a>
<div><div><div><a href="/jobs/121124">Founding Engineer</a></div><div><span>San Francisco, CA, US / Warsaw, PL / Remote</span> · Fulltime · US Citizenship/Visa Not Required · $80K - $150K · 3+ Years</div></div>
<a href="/jobs/121124" aria-label="View job: Founding Engineer">View job</a></div>
<div><div><a href="/jobs/122643">Product Engineer</a></div><div><span>San Francisco, CA, US</span> · Fulltime · Will Sponsor · $160K - $200K · 3+ Years</div></div></div>`;

const HIRIST = `<a href="/j/servify-mobile-application-developer-react-native-1679200?ref=sp_br&jobPos=1"><div data-testid="job-list-1"><p data-testid="job_title">Servify - Mobile Application Developer - React Native</p>
<span data-testid="job_experience">2 - 4 yrs</span><p data-testid="job_location">Hyderabad</p></div></a>`;

const UPLERS = `<div class="jobCardContainer"><div class="jobCard"><div class="jobCardHead"><div class="uplersPartnerBadge" id="partnerHR1179066590848954"></div></div>
<div class="jobTitle"><div class="main"><h6>Full Stack Engineer – Connected Devices</h6><span class="companyName">uDot</span></div></div>
<ul class="jobAttribs"><li>2 - 4 Years Exp</li><li>Remote</li></ul><div class="skills" id="skills_HR1179066590848954"><span>React Native</span></div></div></div>`;

const INSTAHYRE = `<div class="employer-row"><div class="employer-job-name"><h2 class="company-name">Kutumb - Android Engineer</h2></div>
<span class="chip chip-location">Bangalore</span><button class="btn-interested">View job »</button><button class="btn-not-interested">Not interested</button>
<ul id="job-skills-448613"><li>Android</li></ul></div>`;

describe('remote portals: job lists', () => {
  it('Wellfound: company, title, location, Apply on Wellfound only', () => {
    const jobs = wellfoundJobs(html(WELLFOUND));
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ title: 'MERN Stack Developer', company: 'CipherSchools', quick: true });
    expect(jobs[0].url).toMatch(/\/jobs\/5094766-mern-stack-developer$/);
    expect(jobs[0].location).toMatch(/Remote only\s*India/);
    expect(jobs[1].quick).toBe(false);
  });
  it('YC: company from the block, details, visa', () => {
    const jobs = ycJobs(html(YC));
    expect(jobs.map((j) => j.title)).toEqual(['Founding Engineer', 'Product Engineer']);
    expect(jobs[0]).toMatchObject({ company: 'Spine', expMin: 3 });
    expect(openToIndia('yc', jobs[0])).toBe(true);
    expect(openToIndia('yc', jobs[1])).toBe(false);
  });
  it('YC remote jobs page: company, title, location', () => {
    const jobs = ycJobs(
      html(`<div><div><div><div><a href="/companies/instawork" target="company"><span><span>Instawork&nbsp;(S15)</span><span>•</span><span>Hourly work app</span></span></a></div></div>
      <div><a href="/jobs/95530" target="job">Senior Software Engineer - E3</a></div><div><p><span>Full-time</span><span>Bengaluru, KA, IN / Bengaluru, Karnataka, IN</span><span>Full stack</span></p></div></div>
      <div><div><div><a href="/companies/acme" target="company"><span><span>Acme (W24)</span></span></a></div></div><div><a href="/jobs/1" target="job">Backend Engineer</a></div><div><p><span>Full-time</span><span>Remote (US)</span></p></div></div></div>`),
    );
    expect(jobs.map((j) => [j.company, j.title])).toEqual([['Instawork', 'Senior Software Engineer - E3'], ['Acme', 'Backend Engineer']]);
    expect(openToIndia('yc', jobs[0])).toBe(true);
    expect(openToIndia('yc', jobs[1])).toBe(false);
  });
  it('Hirist: company and role split, experience, location', () => {
    const [j] = hiristJobs(html(HIRIST));
    expect(j).toMatchObject({ company: 'Servify', title: 'Mobile Application Developer - React Native', expMin: 2, location: 'Hyderabad' });
    expect(j.url).toMatch(/\/j\/servify-mobile-application-developer-react-native-1679200$/);
    const [k] = hiristJobs(html(HIRIST.replace('Servify - Mobile Application Developer - React Native', 'Senior Software Engineer - React Native')));
    expect(k).toMatchObject({ company: '', title: 'Senior Software Engineer - React Native' });
  });
  it('Uplers: id, title, company, experience, remote', () => {
    const [j] = uplersJobs(html(UPLERS));
    expect(j).toMatchObject({ title: 'Full Stack Engineer – Connected Devices', company: 'uDot', expMin: 2, location: 'Remote' });
    expect(j.url).toMatch(/activeJob=HR1179066590848954$/);
  });
  it('Instahyre: the row as a job (#opp-<id>)', () => {
    const [j] = instahyreJobs(html(INSTAHYRE));
    expect(j).toMatchObject({ company: 'Kutumb', title: 'Android Engineer', location: 'Bangalore' });
    expect(j.url).toMatch(/#opp-448613$/);
  });
  it('Instahyre: "Application Sent!" on the pop-up button counts as sent', () => {
    const doc = document.implementation.createHTMLDocument('x');
    doc.body.innerHTML = '<div role="dialog"><button>Not interested</button><button>Application Sent!</button></div>';
    expect(sentNotice('instahyre', doc, 'https://www.instahyre.com/candidate/opportunities/?matching=true#opp-1')).toBe(true);
  });
  it('Wellfound: the undo window after Send counts as sent', () => {
    const doc = document.implementation.createHTMLDocument('x');
    doc.body.innerHTML = '<div role="dialog"><p>Application scheduled</p><button>Undo</button></div>';
    expect(sentNotice('wellfound', doc, 'https://wellfound.com/jobs/1-x')).toBe(true);
  });
  it('knows the hosts and their lists', () => {
    expect(platformOf('https://wellfound.com/jobs')).toBe('wellfound');
    expect(platformOf('https://www.workatastartup.com/jobs/1')).toBe('yc');
    expect(platformOf('https://platform.uplers.com/talent/all-opportunities')).toBe('uplers');
    expect(platformOf('https://www.hirist.tech/j/x')).toBe('hirist');
    expect(platformOf('https://www.instahyre.com/candidate/opportunities/')).toBe('instahyre');
    expect(searchUrlFor('hirist', 'React Native Developer')).toBe('https://www.hirist.tech/search/react-native-developer?minexp=2&maxexp=4');
  });
  it('Wellfound location check keeps India and remote', () => {
    expect(openToIndia('wellfound', { location: 'Remote only India' })).toBe(true);
    expect(openToIndia('wellfound', { location: 'In office Berlin' })).toBe(false);
  });
});

describe('remote job boards', () => {
  it('Himalayas: allowed countries → a location the India check understands', () => {
    expect(himalayasLocation([])).toBe('Remote · Worldwide');
    expect(himalayasLocation(['India'])).toBe('Remote · India');
    expect(himalayasLocation(['United States', 'Canada'])).toBe('Remote · United States, Canada');
  });
  it('We Work Remotely RSS', () => {
    const jobs = parseWwr(`<rss><channel><item><title>Acme: Senior React Native Engineer</title><region>Anywhere in the World</region><link>https://weworkremotely.com/remote-jobs/acme-rn</link><pubDate>Mon, 16 Nov 2026 10:00:00 +0000</pubDate><description>&lt;p&gt;Hi&lt;/p&gt;</description></item>
      <item><title>Beta: Full-Stack Developer</title><region>USA Only</region><link>https://weworkremotely.com/remote-jobs/beta</link></item></channel></rss>`);
    expect(jobs[0]).toMatchObject({ company: 'Acme', title: 'Senior React Native Engineer', url: 'https://weworkremotely.com/remote-jobs/acme-rn' });
    const fit = fitting(
      jobs.map((j) => ({ ...j, title: j.title.replace('Senior ', '') })),
      { relevant: ['react native', 'full-stack'], skipWords: '', days: 3650, now: Date.parse('2026-11-17') },
    );
    expect(fit.map((j) => j.company)).toEqual(['Acme']);
  });
  it('board pages are followed to the company first', () => {
    expect(BOARD_JOB.test('https://himalayas.app/companies/acme/jobs/react-native-developer')).toBe(true);
    expect(BOARD_JOB.test('https://remoteok.com/remote-jobs/remote-rn-acme-1')).toBe(true);
    expect(onHop('https://himalayas.app/apply/abc')).toBe(true);
    expect(onHop('https://job-boards.greenhouse.io/acme/jobs/1')).toBe(false);
  });
});
