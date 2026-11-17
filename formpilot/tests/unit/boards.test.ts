import { describe, expect, it } from 'vitest';
import { boardFromUrl, fetchBoard, fitting, locationOk, parseBoards, titleFits, DEFAULT_BOARDS } from '@/lib/sitepilot/boards';

describe('boards', () => {
  it('parses the list and drops junk and repeats', () => {
    expect(parseBoards('greenhouse:gitlab, lever:paytm,  ashby:supabase nope:x lever:PAYTM')).toEqual([
      { kind: 'greenhouse', token: 'gitlab' },
      { kind: 'lever', token: 'paytm' },
      { kind: 'ashby', token: 'supabase' },
    ]);
    expect(parseBoards(DEFAULT_BOARDS).length).toBeGreaterThan(20);
  });
  it('learns boards from links', () => {
    expect(boardFromUrl('https://job-boards.greenhouse.io/gitlab/jobs/123')).toEqual({ kind: 'greenhouse', token: 'gitlab' });
    expect(boardFromUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=1')).toEqual({ kind: 'greenhouse', token: 'acme' });
    expect(boardFromUrl('https://jobs.lever.co/paytm/abc/apply')).toEqual({ kind: 'lever', token: 'paytm' });
    expect(boardFromUrl('https://jobs.ashbyhq.com/sarvam/uuid/application')).toEqual({ kind: 'ashby', token: 'sarvam' });
    expect(boardFromUrl('https://acme.recruitee.com/o/dev')).toEqual({ kind: 'recruitee', token: 'acme' });
    expect(boardFromUrl('https://example.com/careers')).toBeNull();
  });
  it('keeps India and remote-open-to-India only', () => {
    expect(locationOk('Bengaluru, Karnataka')).toBe(true);
    expect(locationOk('Remote')).toBe(true);
    expect(locationOk('Remote - APAC')).toBe(true);
    expect(locationOk('Remote, India')).toBe(true);
    expect(locationOk('Remote - US')).toBe(false);
    expect(locationOk('Canada | Remote')).toBe(false);
    expect(locationOk('San Francisco, CA')).toBe(false);
    expect(locationOk('Vienna, Austria · Remote')).toBe(false);
    expect(locationOk('Distributed; Hybrid')).toBe(true);
    expect(locationOk('Global - Remote; United States')).toBe(true);
  });
  it('keeps your titles at your level', () => {
    const rel = ['react native', 'mobile', 'full stack', 'software'];
    expect(titleFits('Senior Software Engineer, Payments', rel, 'Intern')).toBe(true);
    expect(titleFits('Staff Software Engineer', rel, '')).toBe(false);
    expect(titleFits('Lead Software Engineer (Level 5)', rel, '')).toBe(false);
    expect(titleFits('Engineering Manager, Mobile', rel, '')).toBe(false);
    expect(titleFits('Product Designer', rel, '')).toBe(false);
    expect(titleFits('React Native Developer', rel, 'Flutter')).toBe(true);
  });
  it('reads Lever and Greenhouse feeds into apply links', async () => {
    const f = (async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).includes('lever')
            ? [{ text: 'React Native Engineer', hostedUrl: 'https://jobs.lever.co/acme/1', createdAt: Date.now(), categories: { location: 'Bengaluru' } }]
            : { jobs: [{ id: 7, title: 'Software Engineer', location: { name: 'Remote - US' }, updated_at: new Date().toISOString() }] },
        ),
      )) as typeof fetch;
    const lv = await fetchBoard({ kind: 'lever', token: 'acme' }, f);
    expect(lv[0]).toMatchObject({ url: 'https://jobs.lever.co/acme/1/apply', company: 'Acme', location: 'Bengaluru' });
    const gh = await fetchBoard({ kind: 'greenhouse', token: 'acme' }, f);
    expect(gh[0].url).toBe('https://job-boards.greenhouse.io/acme/jobs/7');
    expect(fitting([...lv, ...gh], { relevant: ['react native', 'software'], skipWords: '', days: 21 })).toHaveLength(1);
  });
});

describe('stack and level', () => {
  const stack = 'react native, react, javascript, typescript, node, frontend, full stack, mobile, python';
  it('keeps your stack, drops other specialisms', async () => {
    const { stackFits } = await import('@/lib/sitepilot/boards');
    expect(stackFits({ title: 'React Native Developer' }, stack)).toBe(true);
    expect(stackFits({ title: 'Senior Software Engineer - Security Platform' }, stack)).toBe(false);
    expect(stackFits({ title: 'Software Engineer, Kubernetes platform' }, stack)).toBe(false);
    expect(stackFits({ title: 'Software Engineer', description: 'We use TypeScript, React and Node across the product.' }, stack)).toBe(true);
    expect(stackFits({ title: 'Software Engineer', description: 'Go and Ruby on Rails services.' }, stack)).toBe(false);
  });
  it('leaves Senior roles out unless asked', () => {
    const jobs = [
      { title: 'Senior Software Engineer', company: 'A', location: 'Bengaluru', url: 'u1', description: 'react typescript node' },
      { title: 'Software Engineer II', company: 'A', location: 'Bengaluru', url: 'u2', description: 'react typescript node' },
    ];
    const o = { relevant: ['software'], skipWords: '', days: 30, stack };
    expect(fitting(jobs, { ...o, senior: false }).map((j) => j.url)).toEqual(['u2']);
    expect(fitting(jobs, { ...o, senior: true })).toHaveLength(2);
  });
});
