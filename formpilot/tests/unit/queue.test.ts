import { describe, expect, it } from 'vitest';
import { candidates, companyFrom, dialogCompany, dialogReady, jobCards, paneCompany, pushbackNotice, sameCompany, titleSkipped } from '@/lib/queue';

const card = (title: string, company: string, extra: string[]) =>
  `<div class="x"><div role="button" componentkey="k"><div>${title} (Verified job)</div><div>${title}</div><div>${company}</div><div>Bengaluru</div>${extra.map((e) => `<div>${e}</div>`).join('')}<button aria-label="Dismiss ${title} job">x</button></div></div>`;

describe('apply queue: reading the LinkedIn job list', () => {
  it('reads title, company, applied and Easy Apply from each card', () => {
    document.body.innerHTML = card('Mobile Engineer', 'Acme', ['Applied', '·', 'Easy Apply']) + card('SDE 2', 'Beta', ['·', 'Easy Apply']) + card('Backend', 'Gamma', ['·']);
    const cs = jobCards();
    expect(cs.map((c) => [c.title, c.company, c.applied, c.easyApply])).toEqual([
      ['Mobile Engineer', 'Acme', true, true],
      ['SDE 2', 'Beta', false, true],
      ['Backend', 'Gamma', false, false],
    ]);
    expect(candidates(cs, '', new Set()).map((c) => c.title)).toEqual(['SDE 2']);
  });

  it('skips titles from the skip list and jobs already tried', () => {
    expect(titleSkipped('Engineering Manager (Mobile)', 'engineering manager, Director')).toBe(true);
    expect(titleSkipped('Senior React Native Engineer', 'engineering manager, Director')).toBe(false);
    document.body.innerHTML = card('Engineering Manager', 'D', ['Easy Apply']) + card('SDE 2', 'Beta', ['Easy Apply']);
    expect(candidates(jobCards(), 'Engineering Manager', new Set(['beta|sde 2']))).toEqual([]);
  });

  it('reads the company from live LinkedIn card lines (title, title, company), not the repeated title', () => {
    const t = 'Full-stack app developer (Part-time, Equity only)';
    expect(companyFrom([t, t, 'PD Consulting', 'India (Remote)', 'Actively reviewing applicants', 'Viewed', '·', 'Easy Apply'], t)).toBe('PD Consulting');
    expect(companyFrom([`${t} (Verified job)`, t, 'PD Consulting'], t)).toBe('PD Consulting');
    expect(companyFrom([t, 'Verified job', t, 'Acme'], t)).toBe('Acme');
  });

  it('matches company names loosely and the dialog heading', () => {
    expect(sameCompany('Softnotions Technologies Private Limited', 'Softnotions Technologies Pvt. Ltd.')).toBe(true);
    expect(sameCompany('PD Consulting', 'PD Consulting')).toBe(true);
    expect(sameCompany('Pharmizza Technology Solutions Pvt Ltd', 'Lokal')).toBe(false);
    expect(sameCompany('', 'Lokal')).toBe(true);
    document.body.innerHTML = '<dialog open><div><h2>Apply to Lokal</h2></div><span>0 notifications</span><p>Loading…</p></dialog>';
    const d = document.querySelector('dialog')!;
    expect(dialogCompany(d)).toBe('Lokal');
    expect(dialogReady(d)).toBe(false);
    d.insertAdjacentHTML('beforeend', '<button>Next</button>');
    expect(dialogReady(d)).toBe(true);
  });

  it('takes the company from ?companyName= or the pane, and notices LinkedIn pushing back', () => {
    document.body.innerHTML = '<div role="button" componentkey="k"><a href="/company/x/">Card Co</a></div><a href="https://www.linkedin.com/company/acme/life">Acme Pvt Ltd</a>';
    expect(paneCompany(document, 'https://www.linkedin.com/jobs/view/1/?companyName=Softnotions+Technologies')).toBe('Softnotions Technologies');
    expect(paneCompany(document, 'https://www.linkedin.com/jobs/search-results/?currentJobId=1')).toBe('Acme Pvt Ltd');
    expect(pushbackNotice(document, 'https://www.linkedin.com/checkpoint/challenge/x')).toMatch(/verify/);
    document.body.innerHTML = "<p>You've reached the Easy Apply limit for today.</p>";
    expect(pushbackNotice(document, 'https://www.linkedin.com/jobs/')).toMatch(/limit/);
    document.body.innerHTML = '<p>Jobs you may like</p>';
    expect(pushbackNotice(document, 'https://www.linkedin.com/jobs/')).toBe('');
  });
});
