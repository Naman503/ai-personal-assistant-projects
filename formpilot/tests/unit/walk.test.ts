import { describe, expect, it } from 'vitest';
import { decideStep, emptyRequired, firstEmptyField, stepScope } from '@/lib/walk';

const page = (html: string) => {
  document.body.innerHTML = html;
  return document.body.querySelector<HTMLElement>('[role=dialog], form') ?? document.body;
};

describe('walking a multi-step form', () => {
  it('moves on when the step is complete and only has a Next button', () => {
    const scope = page(`<div role="dialog"><label for="a">Notice</label><input id="a" value="30" required><button type="button"><span>Next</span></button></div>`);
    const d = decideStep(scope);
    expect(d.kind).toBe('next');
  });

  it('stops at Submit and never treats it as a step', () => {
    const scope = page(`<div role="dialog"><input value="x"><button type="button">Submit application</button></div>`);
    const d = decideStep(scope);
    expect(d.kind).toBe('submit');
    expect(d.kind === 'submit' && d.button.textContent).toBe('Submit application');
  });

  it('prefers Submit over Review when both are shown', () => {
    const scope = page(`<form><input value="x"><button type="button">Review</button><button type="submit">Submit</button></form>`);
    expect(decideStep(scope).kind).toBe('submit');
  });

  it('is blocked by an empty required field', () => {
    const scope = page(`<div role="dialog"><label for="a">Phone</label><input id="a" required><button type="button">Next</button></div>`);
    const d = decideStep(scope);
    expect(d.kind).toBe('blocked');
    expect(d.kind === 'blocked' && d.field?.id).toBe('a');
    expect(d.kind === 'blocked' && d.reason).toMatch(/1 required field needs you/);
  });

  it('is blocked by an unchecked required radio group, but not by a checkbox', () => {
    const scope = page(`<div role="dialog">
      <input type="radio" name="r" value="y" required><input type="radio" name="r" value="n" required>
      <input type="checkbox" required>
      <button type="button">Continue</button></div>`);
    expect(emptyRequired(scope).length).toBe(1);
    (scope.querySelector('input[value=y]') as HTMLInputElement).checked = true;
    expect(emptyRequired(scope).length).toBe(0);
    expect(decideStep(scope).kind).toBe('next');
  });

  it('is blocked by a visible validation error', () => {
    const scope = page(`<div role="dialog"><input value="abc" aria-invalid="true"><span class="artdeco-inline-feedback--error">Enter a whole number</span><button type="button">Next</button></div>`);
    const d = decideStep(scope);
    expect(d.kind).toBe('blocked');
    expect(d.kind === 'blocked' && d.reason).toMatch(/error/);
  });

  it('ignores disabled buttons and empty error containers', () => {
    const scope = page(`<div role="dialog"><input value="x"><div class="error-container"></div><button type="button" disabled>Next</button></div>`);
    expect(decideStep(scope).kind).toBe('none');
  });

  it('finds the dialog across a shadow boundary and the first empty field in it', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = `<div role="dialog"><input id="done" value="x"><input id="todo"><button type="button">Next</button></div>`;
    const todo = root.getElementById('todo')!;
    const scope = stepScope(todo);
    expect(scope.getAttribute('role')).toBe('dialog');
    expect(firstEmptyField(scope)?.id).toBe('todo');
  });
});
