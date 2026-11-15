import { describe, expect, it } from 'vitest';
import { frameShouldAct } from '@/lib/frames';

describe('which frame answers a command', () => {
  const base = { hasFocus: false, isTop: true, activeTag: 'BODY', activeIsField: false };
  it('the focused frame always acts', () => {
    expect(frameShouldAct({ ...base, hasFocus: true, via: 'shortcut' })).toBe(true);
  });
  it('the shortcut never wakes an unfocused frame', () => {
    expect(frameShouldAct({ ...base, via: 'shortcut' })).toBe(false);
  });
  it('toolbar Fill works although the popup took focus (LinkedIn Easy Apply in the top frame)', () => {
    expect(frameShouldAct({ ...base, via: 'toolbar' })).toBe(true);
  });
  it('when the user was in an iframe, the iframe acts and the top frame stays out', () => {
    expect(frameShouldAct({ ...base, via: 'toolbar', activeTag: 'IFRAME' })).toBe(false);
    expect(frameShouldAct({ ...base, via: 'toolbar', isTop: false, activeIsField: true })).toBe(true);
    expect(frameShouldAct({ ...base, via: 'context_menu', isTop: false, activeIsField: false })).toBe(false);
  });
});
