import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepTabAwake, releaseTab } from '../../src/lib/tab-awake';

function stubDebugger(attached: boolean, sendFails?: string) {
  const calls: string[] = [];
  const dbg = {
    attach: vi.fn(async () => {
      calls.push('attach');
      attached = true;
    }),
    detach: vi.fn(async () => {
      calls.push('detach');
      attached = false;
    }),
    sendCommand: vi.fn(async (_t: unknown, method: string, params: unknown) => {
      if (sendFails) throw new Error(sendFails);
      if (!attached) throw new Error('Debugger is not attached to the tab with id: 7.');
      calls.push(`${method} ${JSON.stringify(params)}`);
    }),
  };
  vi.stubGlobal('chrome', { ...(globalThis as { chrome?: object }).chrome, debugger: dbg });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('keepTabAwake', () => {
  it('attaches once, then turns on focus emulation', async () => {
    const calls = stubDebugger(false);
    expect(await keepTabAwake(7)).toBe(true);
    expect(calls).toEqual(['attach', 'Emulation.setFocusEmulationEnabled {"enabled":true}']);
  });

  it('reuses an existing attachment (worker restarted)', async () => {
    const calls = stubDebugger(true);
    expect(await keepTabAwake(7)).toBe(true);
    expect(calls).toEqual(['Emulation.setFocusEmulationEnabled {"enabled":true}']);
  });

  it('gives up quietly when the browser refuses (DevTools open)', async () => {
    const calls = stubDebugger(true, 'Another debugger is already attached');
    expect(await keepTabAwake(7)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('releases the tab on stop', async () => {
    const calls = stubDebugger(true);
    await releaseTab(7);
    await releaseTab(undefined);
    expect(calls).toEqual(['detach']);
  });
});
