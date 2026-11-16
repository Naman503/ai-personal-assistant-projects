import { describe, expect, it } from 'vitest';
import { batchSize, freshDay, inActiveHours, ist, linkedInSearchUrl, nextStart, pickTitle, titlesOf } from '@/lib/autopilot';

const ap = { startTime: '10:00', endTime: '19:30', days: [1, 2, 3, 4, 5, 6] };
// 2026-11-16 is a Monday. 10:00 IST = 04:30 UTC.
const utc = (s: string) => new Date(s);

describe('autopilot schedule (India time)', () => {
  it('knows the India date and active hours', () => {
    expect(ist(utc('2026-11-16T20:00:00Z')).date).toBe('2026-11-17'); // 01:30 IST next day
    expect(inActiveHours(ap, utc('2026-11-16T04:29:00Z'))).toBe(false); // 09:59 IST
    expect(inActiveHours(ap, utc('2026-11-16T04:30:00Z'))).toBe(true); // 10:00 IST
    expect(inActiveHours(ap, utc('2026-11-16T14:00:00Z'))).toBe(false); // 19:30 IST
    expect(inActiveHours(ap, utc('2026-11-22T06:00:00Z'))).toBe(false); // Sunday
  });

  it('finds the next start', () => {
    expect(nextStart(ap, utc('2026-11-16T15:00:00Z')).toISOString()).toBe('2026-11-17T04:30:00.000Z'); // Mon evening → Tue 10:00
    expect(nextStart(ap, utc('2026-11-21T15:00:00Z')).toISOString()).toBe('2026-11-23T04:30:00.000Z'); // Sat evening → Mon
    expect(nextStart(ap, utc('2026-11-16T02:00:00Z')).toISOString()).toBe('2026-11-16T04:30:00.000Z'); // Mon 07:30 → 10:00
  });

  it('rotates titles, skipping full and exhausted ones', () => {
    const titles = titlesOf({ titles: 'React Native Developer, Mobile Engineer\nFull Stack Engineer, mobile engineer' });
    expect(titles).toEqual(['React Native Developer', 'Mobile Engineer', 'Full Stack Engineer']);
    const day = freshDay('2026-11-16');
    expect(pickTitle(titles, day, 10)?.title).toBe('React Native Developer');
    expect(pickTitle(titles, day, 10, 0)?.title).toBe('Mobile Engineer');
    day.perTitle['Mobile Engineer'] = 10;
    day.exhausted.push('Full Stack Engineer');
    expect(pickTitle(titles, day, 10, 0)?.title).toBe('React Native Developer');
    day.perTitle['React Native Developer'] = 10;
    expect(pickTitle(titles, day, 10, 0)).toBeNull();
  });

  it('keeps batches inside the daily and per-title limits', () => {
    const lim = { batchMin: 3, batchMax: 5, dailyCap: 25, perTitleCap: 10 };
    const day = freshDay('2026-11-16');
    expect(batchSize(lim, day, 'X', 0)).toBe(3);
    expect(batchSize(lim, day, 'X', 0.999)).toBe(5);
    day.dry = 23;
    expect(batchSize(lim, day, 'X', 0.999)).toBe(2);
    day.dry = 0;
    day.perTitle.X = 9;
    expect(batchSize(lim, day, 'X', 0.999)).toBe(1);
  });

  it('builds the LinkedIn search: Easy Apply, India, last 24 h; remote-only adds the filter', () => {
    const u = new URL(linkedInSearchUrl('React Native Developer', { location: 'india', postedDays: 1 }));
    expect(u.pathname).toBe('/jobs/search-results/');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ keywords: 'React Native Developer', geoId: '102713980', f_AL: 'true', f_TPR: 'r86400' });
    expect(u.searchParams.has('f_WT')).toBe(false);
    expect(new URL(linkedInSearchUrl('X', { location: 'india-remote', postedDays: 7 })).searchParams.get('f_WT')).toBe('2');
  });
});
