import { beforeEach, describe, expect, it } from 'vitest';
import { extractField, extractPage, fieldKind, resolveLabel, siblingFields, pageMainText } from '@/lib/fields/context';

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as unknown as T;

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Apply — Acme';
});

describe('resolveLabel', () => {
  it('uses <label for>', () => {
    document.body.innerHTML = `<label for="e">Work email <span>*</span></label><input id="e" />`;
    expect(resolveLabel($('#e'))).toBe('Work email *');
  });
  it('uses a wrapping label without the nested control text', () => {
    document.body.innerHTML = `<label>Country <select id="s"><option>India</option><option>USA</option></select></label>`;
    expect(resolveLabel($('#s'))).toBe('Country');
  });
  it('uses aria-labelledby (multiple ids)', () => {
    document.body.innerHTML = `<span id="a">Billing</span><span id="b">City</span><input id="i" aria-labelledby="a b" />`;
    expect(resolveLabel($('#i'))).toBe('Billing City');
  });
  it('uses aria-label, then placeholder', () => {
    document.body.innerHTML = `<input id="a" aria-label="Search docs" /><input id="p" placeholder="Your name" />`;
    expect(resolveLabel($('#a'))).toBe('Search docs');
    expect(resolveLabel($('#p'))).toBe('Your name');
  });
  it('reads table-layout labels', () => {
    document.body.innerHTML = `<table><tr><td>Phone</td><td><input id="t" /></td></tr></table>`;
    expect(resolveLabel($('#t'))).toBe('Phone');
  });
  it('reads preceding sibling text (div-based forms)', () => {
    document.body.innerHTML = `<div><div class="q">What is your notice period?</div><div><input id="n" /></div></div>`;
    expect(resolveLabel($('#n'))).toBe('What is your notice period?');
  });
  it('reads inline preceding text nodes', () => {
    document.body.innerHTML = `<p>Age: <input id="age" /></p>`;
    expect(resolveLabel($('#age'))).toBe('Age:');
  });
  it('falls back to a humanised name attribute', () => {
    document.body.innerHTML = `<form><input id="x" name="currentCompany" /></form>`;
    expect(resolveLabel($('#x'))).toBe('current Company');
  });
});

describe('extractField', () => {
  it('collects constraints, help text and section', () => {
    document.body.innerHTML = `
      <form><fieldset><legend>About you</legend>
        <label for="bio">Short bio</label>
        <textarea id="bio" maxlength="280" required aria-describedby="h"></textarea>
        <small id="h">Max 280 characters</small>
      </fieldset></form>`;
    const f = extractField($('#bio'))!;
    expect(f.kind).toBe('textarea');
    expect(f.label).toBe('Short bio');
    expect(f.maxLength).toBe(280);
    expect(f.required).toBe(true);
    expect(f.description).toContain('Max 280 characters');
    expect(f.section).toBe('About you');
    expect(f.longForm).toBe(true);
    expect($('#bio').getAttribute('data-formpilot-id')).toBe(f.fid);
  });
  it('describes select options', () => {
    document.body.innerHTML = `<label for="s">Gender</label><select id="s"><option value="">Choose</option><option value="m">Male</option><option value="f">Female</option></select>`;
    const f = extractField($('#s'))!;
    expect(f.kind).toBe('select');
    expect(f.semantic).toBe('sex');
    expect(f.options?.map((o) => o.label)).toEqual(['Choose', 'Male', 'Female']);
  });
  it('supports contenteditable', () => {
    document.body.innerHTML = `<div id="ed" contenteditable="true" aria-label="Message">Hello</div>`;
    const el = $('#ed');
    expect(fieldKind(el)).toBe('contenteditable');
    const f = extractField(el)!;
    expect(f.label).toBe('Message');
    expect(f.currentValue).toBe('Hello');
  });
  it('ignores non-text inputs', () => {
    document.body.innerHTML = `<input id="c" type="checkbox" /><input id="f" type="file" />`;
    expect(extractField($('#c'))).toBeNull();
    expect(extractField($('#f'))).toBeNull();
  });
});

describe('extractPage', () => {
  it('includes other filled fields but never passwords', () => {
    document.body.innerHTML = `
      <main><h1>Senior Engineer</h1><p>We are hiring a React engineer.</p>
      <form aria-label="Application">
        <label for="n">Name</label><input id="n" value="Jane" />
        <label for="p">Password</label><input id="p" type="password" value="secret" />
        <label for="q">Why us?</label><textarea id="q"></textarea>
      </form></main>`;
    const p = extractPage($('#q'), { pageChars: 1000, otherFields: true, sendUrl: true });
    expect(p.formTitle).toBe('Application');
    expect(p.title).toBe('Apply — Acme');
    expect(p.otherFields).toEqual([{ label: 'Name', value: 'Jane' }]);
    expect(p.pageText).toContain('React engineer');
    expect(p.pageText).not.toContain('secret');
  });
  it('respects zero page budget', () => {
    expect(pageMainText(document, 0)).toBe('');
  });
  it('siblingFields stays within the form', () => {
    document.body.innerHTML = `<form><input id="a"/><input id="b"/></form><form><input id="c"/></form>`;
    expect(siblingFields($('#a')).map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('chat-style questionnaires', () => {
  it('detects generic labels', async () => {
    const { isGenericLabel } = await import('@/lib/fields/context');
    for (const l of ['Type message here...', 'Type your answer', 'Write a reply', 'Message', 'type here', '']) expect(isGenericLabel(l), l).toBe(true);
    for (const l of ['Email', 'Years of experience', 'Why do you want to join?']) expect(isGenericLabel(l), l).toBe(false);
  });
  it('uses the latest question in the conversation as the label', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <div class="chat"><div>Hi! A few questions.</div><div>What is your notice period?</div><div>How many years of experience do you have in Postgresql?</div></div>
        <div id="ci" contenteditable="true" data-placeholder="Type message here..."></div>
      </div>`;
    const f = extractField($('#ci'))!;
    expect(f.label).toBe('How many years of experience do you have in Postgresql?');
    expect(f.chat).toBe(true);
    expect(f.longForm).toBe(false);
  });
  it('auto-opens questionnaire chats in modals but not ordinary chat boxes', async () => {
    const { checkEligibility } = await import('@/lib/fields/eligibility');
    const { DEFAULTS } = await import('@/lib/settings-core');
    document.body.innerHTML = `
      <div role="dialog"><div>Are you willing to relocate?</div><div id="ans" contenteditable="true" data-placeholder="Type message here..."></div></div>
      <div><div>Alice: lunch?</div><div id="slack" contenteditable="true" aria-label="Message #general"></div></div>`;
    expect(checkEligibility($("#ans"), structuredClone(DEFAULTS)).autoOpen).toBe(true);
    expect(checkEligibility($('#slack'), structuredClone(DEFAULTS)).autoOpen).toBe(false);
  });
});

describe('conversationQuestionInfo (backward scan)', () => {
  it('finds the latest question without any container and ignores later text', async () => {
    const { conversationQuestionInfo, lowestCommonAncestor } = await import('@/lib/fields/context');
    document.body.innerHTML = `
      <main><p>Is this a FAQ question?</p></main>
      <div class="w"><div class="p"><div class="log"><div>Hello!</div><div>How many years of experience do you have in SQL Database?</div><div>(answer in years)</div></div>
      <div class="box"><span>Type message here...</span><div id="in" contenteditable="true"></div></div></div></div>
      <footer>Why choose us?</footer>`;
    const el = $('#in');
    const info = conversationQuestionInfo(el);
    expect(info.text).toBe('How many years of experience do you have in SQL Database?');
    expect(lowestCommonAncestor(el, info.block!)?.className).toBe('p');
  });
});
