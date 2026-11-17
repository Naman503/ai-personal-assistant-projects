import { describe, expect, it } from 'vitest';
import { remoteAnswer, TIMEZONE_TEXT } from '@/lib/fields/answers';

const yn = [
  { value: 'Yes', label: 'Yes' },
  { value: 'No', label: 'No' },
];

describe('remote job answers', () => {
  it('says No to work authorization abroad', () => {
    expect(remoteAnswer({ label: 'Are you legally authorized to work in the United States?', options: yn })).toBe('No');
    expect(remoteAnswer({ label: 'Are you eligible to work in the UK?', options: [] })).toBe('No');
  });
  it('gives the time zone, or the IST option', () => {
    expect(remoteAnswer({ label: 'What time zone are you based in?', options: [] })).toBe(TIMEZONE_TEXT);
    expect(remoteAnswer({ label: 'Timezone', options: [{ value: 'pst', label: 'PST (UTC-8)' }, { value: 'ist', label: 'IST (UTC+5:30)' }] })).toBe('IST (UTC+5:30)');
  });
  it('says Yes to overlapping with US hours', () => {
    expect(remoteAnswer({ label: 'Are you able to work at least 4 hours overlapping with US Eastern time?', options: yn })).toBe('Yes');
    expect(remoteAnswer({ label: 'Can you be available during EST business hours?', options: [] })).toBe('Yes');
  });
  it('leaves other questions alone', () => {
    expect(remoteAnswer({ label: 'Have you worked with React Native?', options: yn })).toBeNull();
    expect(remoteAnswer({ label: 'Expected salary', options: [] })).toBeNull();
  });
});
