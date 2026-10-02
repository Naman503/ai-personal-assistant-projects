import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bestOption, coerceForInput, fillElement, fillRadioGroup, restoreElement } from '@/lib/fields/fill';

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as unknown as T;

beforeEach(() => {
  document.body.innerHTML = '';
  // happy-dom has no editing pipeline; make execCommand a no-op so the fallback paths are exercised.
  document.execCommand = vi.fn(() => false);
});

describe('fillElement (text controls)', () => {
  it('uses the prototype setter and fires input + change (React-style controlled inputs)', () => {
    document.body.innerHTML = `<input id="i" />`;
    const el = $<HTMLInputElement>('#i');
    // Simulate React's value tracker overriding the instance property.
    let tracked = '';
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() {
        return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!.call(this);
      },
      set(v) {
        tracked = v;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(this, v);
      },
    });
    const events: string[] = [];
    el.addEventListener('input', (e) => events.push(`input:${(e as InputEvent).inputType}`));
    el.addEventListener('change', () => events.push('change'));
    const r = fillElement(el, 'Jane Doe');
    expect(r.ok).toBe(true);
    expect(r.method).toBe('setter');
    expect(el.value).toBe('Jane Doe');
    expect(tracked).toBe(''); // bypassed the instance setter, as React requires
    expect(events).toEqual(['input:insertReplacementText', 'change']);
  });

  it('prefers execCommand when it works', () => {
    document.body.innerHTML = `<textarea id="t"></textarea>`;
    const el = $<HTMLTextAreaElement>('#t');
    document.execCommand = vi.fn((_c: string, _u?: boolean, v?: string) => {
      el.value = v ?? '';
      return true;
    }) as typeof document.execCommand;
    const r = fillElement(el, 'Line 1\nLine 2');
    expect(r.method).toBe('execCommand');
    expect(el.value).toBe('Line 1\nLine 2');
  });

  it('enforces maxlength on a word boundary', () => {
    document.body.innerHTML = `<input id="i" maxlength="20" />`;
    const el = $<HTMLInputElement>('#i');
    fillElement(el, 'The quick brown fox jumps over');
    expect(el.value.length).toBeLessThanOrEqual(20);
    expect(el.value).toBe('The quick brown fox');
  });

  it('flattens newlines for single-line inputs and records previous value', () => {
    document.body.innerHTML = `<input id="i" value="old" />`;
    const el = $<HTMLInputElement>('#i');
    const r = fillElement(el, 'a\nb');
    expect(el.value).toBe('a b');
    expect(r.previous).toBe('old');
    restoreElement(el, r.previous);
    expect(el.value).toBe('old');
  });

  it('coerces dates, numbers and phones', () => {
    const mk = (type: string) => Object.assign(document.createElement('input'), { type });
    expect(coerceForInput(mk('date'), 'Born on 1994-07-12')).toBe('1994-07-12');
    expect(coerceForInput(mk('date'), 'March 3, 2020')).toMatch(/^2020-03-0[23]$/);
    expect(coerceForInput(mk('number'), 'About 5,000 dollars')).toBe('5000');
    expect(coerceForInput(mk('tel'), 'Call +1 (555) 010-9999 now')).toBe('+1 (555) 010-9999');
    expect(coerceForInput(mk('email'), ' jane @x.com ')).toBe('jane@x.com');
  });
});

describe('selects and radios', () => {
  it('picks the best matching option by label', () => {
    document.body.innerHTML = `<select id="s"><option value="">Select</option><option value="IN">India</option><option value="US">United States</option></select>`;
    const el = $<HTMLSelectElement>('#s');
    const changes = vi.fn();
    el.addEventListener('change', changes);
    const r = fillElement(el, 'united states of america');
    expect(r.ok).toBe(true);
    expect(el.value).toBe('US');
    expect(changes).toHaveBeenCalledOnce();
  });

  it('returns not-ok when nothing matches', () => {
    document.body.innerHTML = `<select id="s"><option value="a">Apple</option></select>`;
    expect(fillElement($('#s'), 'zebra').ok).toBe(false);
  });

  it('bestOption handles value matches and partials', () => {
    const opts = [
      { value: 'm', label: 'Male' },
      { value: 'f', label: 'Female' },
      { value: 'x', label: 'Prefer not to say' },
    ];
    expect(bestOption('female', opts)?.value).toBe('f');
    expect(bestOption('m', opts)?.value).toBe('m');
    expect(bestOption('I prefer not to say', opts)?.value).toBe('x');
  });

  it('clicks the matching radio', () => {
    document.body.innerHTML = `<label><input type="radio" name="r" value="y">Yes</label><label><input type="radio" name="r" value="n">No</label>`;
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
    const r = fillRadioGroup(radios, 'No', (x) => x.parentElement!.textContent!.trim());
    expect(r.ok).toBe(true);
    expect(radios[1].checked).toBe(true);
  });
});

describe('contenteditable', () => {
  it('falls back to textContent and fires input', () => {
    document.body.innerHTML = `<div id="e" contenteditable="true">old</div>`;
    const el = $('#e');
    const onInput = vi.fn();
    el.addEventListener('input', onInput);
    const r = fillElement(el, 'Hello world');
    expect(r.ok).toBe(true);
    expect(el.textContent).toBe('Hello world');
    expect(onInput).toHaveBeenCalled();
  });

  it('uses the paste path when an editor handles paste', () => {
    document.body.innerHTML = `<div id="e" contenteditable="true"></div>`;
    const el = $('#e');
    el.addEventListener('paste', (e) => {
      el.textContent = (e as ClipboardEvent).clipboardData!.getData('text/plain');
      e.preventDefault();
    });
    const r = fillElement(el, 'Pasted text');
    expect(r.method).toBe('paste');
    expect(el.textContent).toBe('Pasted text');
  });
});
