import { describe, expect, it } from 'vitest';
import { clearAllPositions, clearPosition, loadPositions, positionKey, resolvePos, savePosition, toScreenPos } from '@/lib/panel-position';

describe('popup positions', () => {
  it('round-trips a screen position', () => {
    const pos = toScreenPos(300, 200, 400, 300, 1280, 800);
    expect(resolvePos(pos, 400, 300, 1280, 800)).toEqual({ x: 300, y: 200 });
  });

  it('a popup docked at the right edge stays docked when the window shrinks or grows', () => {
    const pos = toScreenPos(1280 - 400 - 8, 8, 400, 300, 1280, 800); // top-right corner
    expect(resolvePos(pos, 400, 300, 1000, 700)).toEqual({ x: 1000 - 400 - 8, y: 8 });
    expect(resolvePos(pos, 400, 300, 1920, 1080)).toEqual({ x: 1920 - 400 - 8, y: 8 });
  });

  it('never leaves the viewport', () => {
    const r = resolvePos({ mode: 'field', dx: 5000, dy: -5000 }, 400, 300, 1280, 800, new DOMRect(100, 100, 200, 30));
    expect(r.x).toBeLessThanOrEqual(1280 - 400 - 8);
    expect(r.y).toBe(8);
  });

  it('field mode keeps the offset from the field', () => {
    expect(resolvePos({ mode: 'field', dx: 20, dy: 40 }, 300, 200, 1280, 800, new DOMRect(100, 100, 200, 30))).toEqual({ x: 120, y: 140 });
  });

  it('keys per site / everywhere / off and persists', async () => {
    expect(positionKey('jobs.example.com', 'per-site')).toBe('jobs.example.com');
    expect(positionKey('jobs.example.com', 'everywhere')).toBe('*');
    expect(positionKey('jobs.example.com', 'off')).toBeNull();
    await savePosition('a.com', { mode: 'screen', fx: 1, fy: 0 });
    await savePosition('*', { mode: 'field', dx: 1, dy: 2 });
    expect(Object.keys(await loadPositions()).sort()).toEqual(['*', 'a.com']);
    await clearPosition('a.com');
    expect(Object.keys(await loadPositions())).toEqual(['*']);
    await clearAllPositions();
    expect(await loadPositions()).toEqual({});
  });
});
