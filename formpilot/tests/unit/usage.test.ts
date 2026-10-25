import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings';
import { counterKey, errorFingerprint, parseCounterKey, providerFamily, UsageReporter, usageSource } from '@/lib/usage';

const settingsWith = (privacy: Partial<Settings['privacy']>): Settings => ({
  ...DEFAULT_SETTINGS,
  privacy: { ...DEFAULT_SETTINGS.privacy, ...privacy },
});

describe('usage helpers', () => {
  it('maps sources and provider families without URLs', () => {
    expect(usageSource('fact')).toBe('memory');
    expect(usageSource('weird')).toBe('other');
    expect(providerFamily({ id: 'groq', kind: 'openai' })).toBe('groq');
    expect(providerFamily({ id: 'custom-ab12cd', kind: 'openai' })).toBe('openai_compatible');
    expect(providerFamily({ id: 'chrome-ai', kind: 'chrome-ai' })).toBe('chrome_ai');
    expect(providerFamily({ id: 'ollama-x9y8z7', kind: 'ollama' })).toBe('ollama');
    expect(providerFamily(undefined)).toBe('none');
  });
  it('round-trips counter keys', () => {
    const k = counterKey('2026-10-25', 'fields_filled', { source: 'ai' });
    expect(parseCounterKey(k)).toEqual({ day: '2026-10-25', name: 'fields_filled', props: { source: 'ai' } });
    expect(parseCounterKey('x')).toBeNull();
  });
  it('fingerprints errors without their message', () => {
    expect(errorFingerprint('TypeError', 'TypeError: secret\n    at a (x.js:1:2)')).toBe(
      errorFingerprint('TypeError', 'TypeError: other\n    at a (x.js:1:2)'),
    );
  });
});

describe('UsageReporter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{"sharing":"on"}', { status: 200 }));
    vi.spyOn(chrome.runtime, 'getManifest').mockReturnValue({ version: '1.1.0' } as chrome.runtime.Manifest);
  });

  it('sends events and finished days, then forgets them', async () => {
    const r = new UsageReporter(() => DEFAULT_SETTINGS, fetchMock as unknown as typeof fetch);
    await r.event('form_filled');
    await r.once('first_fill');
    await r.once('first_fill');
    await chrome.storage.local.set({
      usage: {
        ...((await chrome.storage.local.get('usage')).usage as object),
        counters: { [counterKey('2000-01-01', 'fields_filled', { source: 'ai' })]: 3 },
      },
    });
    await r.flush();
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.e.map((e: { n: string }) => e.n)).toEqual(['form_filled', 'first_fill', 'fields_filled']);
    expect(body.e[2]).toMatchObject({ c: 3, p: { source: 'ai' } });
    expect(JSON.stringify(body)).not.toMatch(/http|baseUrl|apiKey/);
    fetchMock.mockClear();
    await r.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records and sends nothing in Local-only mode', async () => {
    const r = new UsageReporter(() => settingsWith({ localOnly: true }), fetchMock as unknown as typeof fetch);
    await r.event('form_filled');
    await r.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turning it off clears the queue and asks the server to delete', async () => {
    let s = DEFAULT_SETTINGS;
    const r = new UsageReporter(() => s, fetchMock as unknown as typeof fetch);
    await r.event('form_filled');
    s = settingsWith({ shareUsage: false });
    await r.turnedOff();
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({ off: true });
    expect(body.e).toBeUndefined();
  });
});
