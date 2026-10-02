import { beforeEach, describe, expect, it } from 'vitest';
import { checkEligibility, hasOwnAutocomplete, looksLikeSearch, siteAllowed } from '@/lib/fields/eligibility';
import { DEFAULTS } from '@/lib/settings-core';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const S = () => structuredClone(DEFAULTS);

beforeEach(() => (document.body.innerHTML = ''));

describe('eligibility', () => {
  it('auto-opens on a normal text input', () => {
    document.body.innerHTML = `<label for="a">Name</label><input id="a" />`;
    expect(checkEligibility($('#a'), S())).toMatchObject({ ok: true, autoOpen: true, showIcon: true });
  });
  it('never handles passwords or sensitive fields, even when forced', () => {
    document.body.innerHTML = `<input id="p" type="password" /><label for="c">Card number</label><input id="c" /><input id="o" autocomplete="one-time-code" />`;
    for (const id of ['#p', '#c', '#o']) expect(checkEligibility($(id), S(), true).ok, id).toBe(false);
  });
  it('skips disabled / readonly', () => {
    document.body.innerHTML = `<input id="d" disabled /><input id="r" readonly />`;
    expect(checkEligibility($('#d'), S()).ok).toBe(false);
    expect(checkEligibility($('#r'), S()).ok).toBe(false);
  });
  it('does not auto-open on search boxes or site autocompletes', () => {
    document.body.innerHTML = `<input id="s" type="search" /><input id="q" name="q" /><input id="ac" aria-autocomplete="list" /><div role="search"><input id="x"/></div>`;
    expect(looksLikeSearch($('#s'))).toBe(true);
    expect(looksLikeSearch($('#q'))).toBe(true);
    expect(looksLikeSearch($('#x'))).toBe(true);
    expect(hasOwnAutocomplete($('#ac'))).toBe(true);
    expect(checkEligibility($('#s'), S()).autoOpen).toBe(false);
    expect(checkEligibility($('#ac'), S()).autoOpen).toBe(false);
  });
  it('respects trigger mode and contenteditable setting', () => {
    document.body.innerHTML = `<input id="a" aria-label="City"/><div id="e" contenteditable="true"></div>`;
    const s = S();
    s.behavior.trigger = 'icon';
    expect(checkEligibility($('#a'), s)).toMatchObject({ autoOpen: false, showIcon: true });
    s.behavior.trigger = 'shortcut';
    expect(checkEligibility($('#a'), s)).toMatchObject({ autoOpen: false, showIcon: false });
    expect(checkEligibility($('#e'), S()).autoOpen).toBe(false);
  });
  it('site rules', () => {
    const s = S();
    expect(siteAllowed('jobs.example.com', s)).toBe(true);
    s.behavior.blockedSites = ['example.com'];
    expect(siteAllowed('jobs.example.com', s)).toBe(false);
    s.behavior.blockedSites = [];
    s.behavior.siteMode = 'allowlist';
    s.behavior.allowedSites = ['*.lever.co'];
    expect(siteAllowed('jobs.lever.co', s)).toBe(true);
    expect(siteAllowed('google.com', s)).toBe(false);
    s.behavior.enabled = false;
    expect(siteAllowed('jobs.lever.co', s)).toBe(false);
  });
});
