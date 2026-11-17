/** Shared by the runner and the screens: where a paused autopilot batch picks up, in words. */
import { PLATFORM_NAME, type Platform, type SiteJob } from './sites';

export interface ResumableBatch {
  platform?: Platform;
  title: string;
  batch: number;
  stage?: 'list' | 'job' | 'pause' | 'rec';
  jobs?: SiteJob[];
  i?: number;
  sent?: number;
  dry?: number;
  skipped?: number;
}

/** Where a paused batch picks up, in words. */
export function resumePoint(cur: ResumableBatch): string {
  const name = PLATFORM_NAME[cur.platform ?? 'linkedin'];
  const done = `${cur.sent ?? 0} sent${cur.dry ? `, ${cur.dry} would apply` : ''}${cur.skipped ? `, ${cur.skipped} skipped` : ''}`;
  if ((cur.platform ?? 'linkedin') === 'linkedin') return `${name} "${cur.title}", ${cur.batch} more to apply in this batch`;
  if (cur.stage === 'rec') return `${name} Recommended jobs (${cur.batch} to pick)`;
  if (cur.stage === 'list' || !cur.jobs?.length) return `${name} "${cur.title}" (reads the job list again)`;
  return `${name} "${cur.title}", job ${Math.min((cur.i ?? 0) + 1, cur.jobs.length)} of ${cur.jobs.length} (${done} in this batch)`;
}

