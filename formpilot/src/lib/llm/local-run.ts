/**
 * How local model calls (Ollama) run while you use the Mac.
 *
 * The model needs the GPU (CPU-only was measured at over 10 minutes per answer on an M4), so
 * what can be tuned is when and how often it runs and how much memory it keeps:
 *  - you're "active" when Chrome saw keyboard or mouse input in the last N minutes (chrome.idle);
 *  - while you're active: fewer calls per minute, a smaller model if you set one, and the model
 *    is unloaded sooner; or, for background work (Site Pilot), no calls at all until you're away;
 *  - while you're away: the normal pace.
 */
import type { Settings } from '../settings';
import { sleep } from '../util';

export type LocalRun = Settings['localAi'];

const DEFAULT: LocalRun = { whenActive: 'slow', idleMinutes: 3, keepAlive: '5m', numCtx: 8192, lightModel: '', rpmActive: 2, rpmIdle: 6 };
let cfg: LocalRun = DEFAULT;

export function setLocalRun(c: LocalRun | undefined) {
  cfg = c ?? DEFAULT;
}
export const localRun = () => cfg;

let cached: { at: number; active: boolean } | null = null;

/** Is someone using the Mac right now? (No idle API: treated as away.) */
export async function userActive(now = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < 10_000) return cached.active;
  let active = false;
  try {
    const q = chrome.idle?.queryState;
    if (q) active = (await q(Math.max(60, cfg.idleMinutes * 60))) === 'active';
  } catch {
    active = false;
  }
  cached = { at: now, active };
  return active;
}

/** For tests. */
export function resetLocalRun() {
  cached = null;
  calls.length = 0;
  cfg = DEFAULT;
}

const calls: number[] = [];

/** Calls allowed per minute in this state. */
export function rpmFor(active: boolean, c: LocalRun = cfg): number {
  return active && c.whenActive !== 'full' ? c.rpmActive : c.rpmIdle;
}

/** Ollama request settings for this state: model, keep_alive and options. */
export function ollamaSettings(model: string, active: boolean, c: LocalRun = cfg): { model: string; keep_alive: string | number; options: { num_ctx: number } } {
  const slow = active && c.whenActive !== 'full';
  const keep = slow && c.keepAlive === '30m' ? '5m' : c.keepAlive;
  return {
    model: slow && c.lightModel.trim() ? c.lightModel.trim() : model,
    keep_alive: keep === '0' ? 0 : keep,
    options: { num_ctx: c.numCtx },
  };
}

/**
 * Wait until a local call may run. `canPause`: background work that may wait for you to be away
 * (Site Pilot); form filling you started yourself, or the Autopilot's fallback, never waits for that.
 * `onWait` is told why it's waiting (shown on the Site Pilot page).
 */
export async function localGate(signal: AbortSignal, opts: { canPause?: boolean; onWait?: (why: string) => void } = {}): Promise<{ active: boolean }> {
  for (;;) {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const active = await userActive();
    if (active && cfg.whenActive === 'pause' && opts.canPause) {
      opts.onWait?.(`waiting until you've been away for ${cfg.idleMinutes} min`);
      cached = null;
      await sleep(20_000, signal);
      continue;
    }
    const now = Date.now();
    while (calls.length && now - calls[0] > 60_000) calls.shift();
    const rpm = rpmFor(active);
    if (calls.length < rpm) {
      calls.push(now);
      return { active };
    }
    const wait = 60_000 - (now - calls[0]) + 200;
    opts.onWait?.(`${active ? 'you are using the Mac: ' : ''}${rpm} model call${rpm > 1 ? 's' : ''} a minute, next in ${Math.ceil(wait / 1000)} s`);
    await sleep(Math.min(wait, 20_000), signal);
  }
}
