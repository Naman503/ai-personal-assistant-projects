import { describe, expect, it } from 'vitest';
import { cleanSuggestion, parseBatch, parseFacts, parseSuggestions, parseSuggestionsPartial } from '@/lib/engine/parse';
import { redactSecrets } from '@/lib/engine/redact';

describe('parseSuggestions', () => {
  it('parses strict JSON', () => {
    const r = parseSuggestions('{"suggestions":[{"title":"Short","text":"Hi"},{"title":"Long","text":"Hello there"}],"missing":""}');
    expect(r.json).toBe(true);
    expect(r.items.map((i) => i.text)).toEqual(['Hi', 'Hello there']);
  });
  it('handles code fences and prose', () => {
    const r = parseSuggestions('Sure! Here you go:\n```json\n{"suggestions":[{"title":"A","text":"x"}]}\n```');
    expect(r.items[0].text).toBe('x');
  });
  it('accepts alternative shapes', () => {
    expect(parseSuggestions('{"options":["a","b"]}').items.map((i) => i.text)).toEqual(['a', 'b']);
    expect(parseSuggestions('[{"value":"v"}]').items[0].text).toBe('v');
    expect(parseSuggestions('{"answer":"42"}').items[0].text).toBe('42');
  });
  it('falls back to raw text when the model ignores JSON', () => {
    const r = parseSuggestions('I am passionate about building great products.');
    expect(r.json).toBe(false);
    expect(r.items[0].text).toBe('I am passionate about building great products.');
  });
  it('dedupes and reports missing info', () => {
    const r = parseSuggestions('{"suggestions":[{"text":"Same"},{"text":"same "}],"missing":"phone number"}');
    expect(r.items).toHaveLength(1);
    expect(r.missing).toBe('phone number');
  });
  it('repairs truncated JSON', () => {
    const r = parseSuggestions('{"suggestions":[{"title":"A","text":"complete"},{"title":"B","text":"cut of');
    expect(r.items[0].text).toBe('complete');
  });
  it('partial parsing during streaming includes the in-progress string', () => {
    expect(parseSuggestionsPartial('{"suggestions":[{"title":"A","text":"Hel').map((x) => x.text)).toEqual(['Hel']);
    expect(parseSuggestionsPartial('plain stream')).toEqual([{ title: '', text: 'plain stream' }]);
  });
  it('cleanSuggestion strips quotes and preambles', () => {
    expect(cleanSuggestion('"Hello"')).toBe('Hello');
    expect(cleanSuggestion("Here's a suggestion: Hello")).toBe('Hello');
    expect(cleanSuggestion('**Bold**')).toBe('Bold');
  });
});

describe('parseBatch / parseFacts', () => {
  it('batch array and map shapes', () => {
    expect(parseBatch('{"fields":[{"id":"f1","value":"a"},{"id":"f2","value":""}]}')).toEqual({ f1: 'a', f2: '' });
    expect(parseBatch('{"f1":"x"}')).toEqual({ f1: 'x' });
  });
  it('facts filters junk', () => {
    expect(parseFacts('{"facts":[{"label":"Email","value":"a@b.c"},{"label":"Phone","value":"N/A"},{"label":"","value":"x"}]}')).toEqual([{ label: 'Email', value: 'a@b.c' }]);
  });
});

describe('redactSecrets', () => {
  it('masks Luhn-valid cards, keys and passwords but not phone numbers', () => {
    // Fake key assembled at runtime so secret scanners don't flag the test file.
    const fakeKey = ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv'].join('');
    const out = redactSecrets(`card 4111 1111 1111 1111 phone 9876543210 key ${fakeKey} password: hunter2`);
    expect(out).toContain('[card]');
    expect(out).toContain('9876543210');
    expect(out).toContain('[api-key]');
    expect(out).toContain('password: [redacted]');
    expect(out).not.toContain('hunter2');
  });
  it('keeps non-Luhn digit runs', () => {
    expect(redactSecrets('order 1234 5678 9012 3456')).toContain('1234 5678 9012 3456');
  });
});
