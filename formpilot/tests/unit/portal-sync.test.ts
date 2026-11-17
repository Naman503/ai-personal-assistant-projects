import { describe, expect, it } from 'vitest';
import { cutshortItem, naukriItem, naukriTime } from '@/lib/portal-sync';

describe('portal sync', () => {
  it('reads Naukri times as India time', () => {
    expect(naukriTime('2026-11-17 19:41:13')).toBe('2026-11-17T14:11:13.000Z');
  });
  it('turns a Naukri history row into an import item with every status', () => {
    const it = naukriItem({ jobId: '211026012170', jobTitle: 'Lead Engineer - Mobile', company: 'Info Edge', location: 'Bengaluru', logoPath: 'https://img/x.gif', status: [{ statusValue: 'Applied', dateTime: '2026-11-17 19:34:31' }, { statusValue: 'Shortlisted', dateTime: '2026-11-18 10:00:00' }] });
    expect(it?.url).toBe('https://www.naukri.com/job-listings-lead-engineer-mobile-info-edge-211026012170');
    expect(it?.appliedAt).toBe('2026-11-17T14:04:31.000Z');
    expect(it?.events.map((e) => e.status)).toEqual(['Applied', 'Shortlisted']);
  });
  it('skips Naukri rows without a title or date', () => {
    expect(naukriItem({ jobId: '1', jobTitle: '', company: 'X', status: [] })).toBeNull();
  });
  it('maps Cutshort lists to statuses and falls back to the job context for removed jobs', () => {
    const base = { _id: 'c1', creationDate: '2026-10-02T10:45:22.329Z', lastMsgDate: '2026-10-06T18:25:43.041Z', jobSignalContext: { headline: 'Fullstack Mobile Engineer', publicUrl: 'https://cutshort.io/job/x' }, companyDetails: { name: 'superkalam' } };
    expect(cutshortItem(base, 'nottakenforward')?.events.at(-1)?.status).toBe('Not Shortlisted');
    expect(cutshortItem({ ...base, resumeSeen: true }, 'awaiting')?.events.at(-1)?.status).toBe('Resume Viewed');
    expect(cutshortItem({ ...base, lastMsgText: 'this role is not a good fit for your profile' }, 'replied')?.events.at(-1)?.status).toBe('Not Shortlisted');
    expect(cutshortItem({ ...base, jobSignalContext: undefined }, 'awaiting')).toBeNull();
    expect(cutshortItem(base, 'shortlisted')?.role).toBe('Fullstack Mobile Engineer');
  });
});
