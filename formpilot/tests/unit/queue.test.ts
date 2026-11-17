import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { candidates, closeButton, easyApplyButton, pushbackKind, companyFrom, dialogCompany, dialogReady, isSentDialog, jobCards, paneCompany, pushbackNotice, sameCompany, titleSkipped, upsellDecline } from '@/lib/queue';

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

describe('pop-ups over the job list', () => {
  const dialog = (html: string) => {
    document.body.innerHTML = `<div role="dialog">${html}</div>`;
    return document.body.querySelector('[role=dialog]')!;
  };
  const SENT = `<button aria-label="Dismiss"><svg></svg></button><h2>Your application was sent to Scoutit!</h2>
    <p>You can keep track of your application in the "Applied" tab of My Jobs</p>
    <h3>Turn your resume into a profile that recruiters notice</h3>
    <button>Not now</button><button>Update profile</button>`;

  it('says "Not now" to the profile offer after a send, never "Update profile"', () => {
    const d = dialog(SENT);
    expect(isSentDialog(d)).toBe(true);
    expect(closeButton(d)?.textContent).toBe('Not now');
    expect(upsellDecline(d)?.textContent).toBe('Not now');
  });

  it('declines other offers, falls back to the X, and leaves application forms alone', () => {
    expect(upsellDecline(dialog(`<h2>Try Premium for ₹0</h2><button>Try now</button><button>No thanks</button>`))?.textContent).toBe('No thanks');
    expect(upsellDecline(dialog(`<button aria-label="Dismiss"></button><h2>Get job alerts</h2><button>Turn on</button>`))?.getAttribute('aria-label')).toBe('Dismiss');
    expect(upsellDecline(dialog(`<h2>Apply to Acme</h2><input name="phone"><button aria-label="Dismiss"></button><button>Next</button>`))).toBeNull();
  });
});

describe('the Easy Apply control', () => {
  it('is found as a button (before 17 Nov) or a link (LinkedIn since 17 Nov evening)', () => {
    document.body.innerHTML = `<button aria-label="Easy Apply to this job">Easy Apply</button>`;
    expect(easyApplyButton()?.tagName).toBe('BUTTON');
    document.body.innerHTML = `<a aria-label="Easy Apply to this job" aria-disabled="false" href="/jobs/search-results/?currentJobId=1">Easy Apply</a>`;
    expect(easyApplyButton()?.tagName).toBe('A');
    document.body.innerHTML = `<a aria-label="Easy Apply to this job" aria-disabled="true" href="#">Easy Apply</a>`;
    expect(easyApplyButton()).toBeNull();
  });
});

describe('LinkedIn pushback', () => {
  it('reads the daily Easy Apply limit pop-up (markup captured live, 17 Nov)', () => {
    document.body.innerHTML = readFileSync('tests/fixtures/linkedin-limit-dialog.html', 'utf8');
    const msg = pushbackNotice(document, 'https://www.linkedin.com/jobs/search-results/?currentJobId=1');
    expect(msg).toMatch(/Easy Apply limit/i);
    expect(pushbackKind(msg)).toBe('limit');
  });
  it('a checkpoint or sign-in page is a security stop, not a limit', () => {
    document.body.innerHTML = '<p>Let’s do a quick security check</p>';
    expect(pushbackKind(pushbackNotice(document, 'https://www.linkedin.com/feed/'))).toBe('security');
    expect(pushbackKind(pushbackNotice(document, 'https://www.linkedin.com/checkpoint/challenge'))).toBe('security');
  });
});
