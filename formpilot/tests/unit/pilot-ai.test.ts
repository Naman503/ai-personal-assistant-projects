import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings';
import { pilotProviders, pilotSettings, describePilotAi } from '@/lib/llm/pilot-ai';
import { siteSettings } from '@/lib/sitepilot/runner';
import { loadAiStats, recordAiCall, recordOutcome, reportRows, resetAiStats } from '@/lib/ai-stats';

const withGemini = (patch: Partial<Settings['pilotAi']> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  providers: [
    { ...DEFAULT_SETTINGS.providers.find((p) => p.kind === 'gemini')!, apiKey: 'k', enabled: true, model: 'gemini-3-flash' },
    { ...DEFAULT_SETTINGS.providers.find((p) => p.kind === 'ollama')!, enabled: true, baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b' },
  ],
  pilotAi: { ...DEFAULT_SETTINGS.pilotAi, ...patch },
});

describe('pilot AI', () => {
  it('Autopilot: Gemini, then the local model', () => {
    const p = pilotProviders(withGemini(), 'autopilot');
    expect(p.map((x) => x.kind)).toEqual(['gemini', 'ollama']);
    expect(p[1].model).toBe('gemma4:12b');
    expect(describePilotAi(withGemini(), 'autopilot')).toContain('then local gemma4:12b');
  });
  it('Site Pilot: local only by default; cloud when chosen', () => {
    expect(pilotProviders(withGemini(), 'sitePilot').map((x) => x.kind)).toEqual(['ollama']);
    const s = withGemini({ sitePilot: { mode: 'cloud', cloud: '', localModel: '' } });
    expect(siteSettings(s).providers.map((x) => x.kind)).toEqual(['gemini']);
  });
  it('leaves your own AI Providers alone', () => {
    const s = withGemini({ autopilot: { mode: 'local', cloud: '', localModel: 'gemma4:e4b' } });
    expect(pilotSettings(s, 'autopilot').providers.map((x) => x.model)).toEqual(['gemma4:e4b']);
    expect(s.providers.map((x) => x.model)).toEqual(['gemini-3-flash', 'qwen2.5:7b']);
  });
  it('falls back to local when no cloud provider is set up', () => {
    expect(pilotProviders(DEFAULT_SETTINGS, 'autopilot').map((x) => x.id)).toEqual(['pilot-local']);
  });
});

describe('AI report', () => {
  beforeEach(() => resetAiStats());
  it('adds up calls and outcomes per model', async () => {
    await recordAiCall('sitePilot', 'local gemma4:12b', { ms: 4000, asked: 4, answered: 3 });
    await recordAiCall('sitePilot', 'local gemma4:12b', { ms: 2000, asked: 2, answered: 2 });
    await recordAiCall('sitePilot', 'Gemini gemini-3-flash', { ms: 800, asked: 2, answered: 2 });
    await recordOutcome('sitePilot', 'local gemma4:12b', 'ready');
    await recordOutcome('sitePilot', 'local gemma4:12b', 'needs-you');
    const rows = reportRows(await loadAiStats(), 'sitePilot');
    const local = rows.find((r) => r.model === 'local gemma4:12b')!;
    expect(local.calls).toBe(2);
    expect(local.answerRate).toBeCloseTo(5 / 6);
    expect(local.avgSec).toBe(3);
    expect(local.completion).toBe(0.5);
  });
});
