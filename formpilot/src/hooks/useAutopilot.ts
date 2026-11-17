import { useEffect, useState } from 'react';
import { rpc } from '@/lib/messages';
import type { ApState } from '@/lib/autopilot-runner';
import { resumePoint } from '@/lib/autopilot-resume';

export const time = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const left = (ms: number) => {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};

/** What the autopilot is doing, in words, with what you can do about it. */
export function describe(st: ApState | null): { tone: 'green' | 'amber' | 'neutral' | 'red'; title: string; detail: string; canSkip: boolean } {
  if (st && !st.running && st.phase === 'paused')
    return { tone: 'amber', title: 'Paused', detail: st.current ? `Resume picks up at ${resumePoint(st.current)}` : 'Resume starts the next batch', canSkip: false };
  if (!st || !st.running) return { tone: 'neutral', title: 'Off', detail: st?.message ?? 'Not running', canSkip: false };
  const fresh = st.progress && Date.now() - st.progress.at < 10 * 60_000 ? st.progress.text : '';
  switch (st.phase) {
    case 'loading':
      return { tone: 'green', title: `Opening ${st.current?.platform ?? 'LinkedIn'}: "${st.current?.title ?? ''}"`, detail: fresh || 'Loading the job list in its window', canSkip: false };
    case 'batch': {
      const pause = /^Pause before the next job/.test(fresh);
      const where = st.current?.platform ? `${st.current.platform[0].toUpperCase()}${st.current.platform.slice(1)} · ` : '';
      return { tone: 'green', title: pause ? 'Short pause between jobs' : `${where}Applying: "${st.current?.title ?? ''}"`, detail: fresh || `Batch of ${st.current?.batch ?? '?'}`, canSkip: pause };
    }
    case 'waiting':
      return { tone: 'amber', title: 'Break between batches', detail: st.nextAt ? `Next batch at ${time(st.nextAt)} (in ${left(st.nextAt)})` : st.message, canSkip: true };
    case 'ai-wait':
      return { tone: 'amber', title: 'Waiting for the AI', detail: st.message, canSkip: true };
    case 'outside-hours':
      return { tone: 'neutral', title: 'Outside active hours', detail: st.nextAt ? `Starts again at ${time(st.nextAt)}` : st.message, canSkip: true };
    case 'done-today':
      return { tone: 'neutral', title: 'Done for today', detail: st.message, canSkip: false };
    default:
      return { tone: 'neutral', title: st.phase, detail: st.message, canSkip: false };
  }
}

export function useAutopilot(every = 2000) {
  const [st, setSt] = useState<ApState | null>(null);
  const call = (action: 'start' | 'stop' | 'pause' | 'reset' | 'status' | 'run-now' | 'unblock', platform?: import('@/lib/sites').Platform) => rpc<ApState>({ type: 'autopilot', action, platform }).then(setSt).catch(() => {});
  useEffect(() => {
    void call('status');
    const t = setInterval(() => void call('status'), every);
    return () => clearInterval(t);
  }, [every]);
  return { st, call };
}

