import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings, loadSettings, saveSettings } from '@/lib/settings';
import { DEFAULTS, mergeSettings, providerConfigured, providerFromPreset, isLocalProvider } from '@/lib/settings-core';

describe('settings', () => {
  it('zod defaults and the zod-free DEFAULTS literal are identical', () => {
    expect(DEFAULT_SETTINGS).toEqual(DEFAULTS);
  });
  it('repairs corrupt values field-by-field', () => {
    const s = parseSettings({ generation: { numSuggestions: 99, temperature: 'hot', tone: 'pirate' }, behavior: { trigger: 'focus', minFieldWidth: -5 }, junk: 1 });
    expect(s.generation.numSuggestions).toBe(3);
    expect(s.generation.temperature).toBe(0.7);
    expect(s.generation.tone).toBe('auto');
    expect(s.behavior.minFieldWidth).toBe(80);
    expect((s as unknown as Record<string, unknown>).junk).toBeUndefined();
    expect(parseSettings(null)).toEqual(DEFAULTS);
    expect(parseSettings('garbage')).toEqual(DEFAULTS);
  });
  it('mergeSettings keeps valid stored values and fills gaps', () => {
    const s = mergeSettings({ generation: { numSuggestions: 2 }, behavior: { blockedSites: ['a.com'], trigger: 5 } });
    expect(s.generation.numSuggestions).toBe(2);
    expect(s.generation.tone).toBe('auto');
    expect(s.behavior.blockedSites).toEqual(['a.com']);
    expect(s.behavior.trigger).toBe('focus');
  });
  it('round-trips through chrome.storage', async () => {
    const s = structuredClone(DEFAULTS);
    s.generation.persona = 'Engineer';
    await saveSettings(s);
    expect((await loadSettings()).generation.persona).toBe('Engineer');
  });
  it('provider readiness', () => {
    expect(providerConfigured(providerFromPreset('gemini'))).toBe(false);
    expect(providerConfigured({ ...providerFromPreset('gemini'), apiKey: 'x' })).toBe(true);
    expect(providerConfigured(providerFromPreset('lmstudio', { model: 'qwen' }))).toBe(true);
    expect(providerConfigured({ ...providerFromPreset('groq'), enabled: false, apiKey: 'x' })).toBe(false);
    expect(isLocalProvider(providerFromPreset('ollama'))).toBe(true);
    expect(isLocalProvider(providerFromPreset('groq'))).toBe(false);
  });
});
