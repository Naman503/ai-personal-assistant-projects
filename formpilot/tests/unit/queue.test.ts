import { describe, expect, it } from 'vitest';
import { candidates, jobCards, titleSkipped } from '@/lib/queue';

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
});
