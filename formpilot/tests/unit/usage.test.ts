import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings';
import { charsBucket, counterKey, countBucket, docKind, errorCategory, errorFingerprint, msBucket, optionsSection, parseCounterKey, providerFamily, sanitizeClientEvent, settingsSnapshot, UsageReporter, usageSource } from '@/lib/usage';

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

describe('richer usage helpers', () => {
  it('buckets latencies, counts and sizes', () => {
    expect(msBucket(120)).toBe('<0.5s');
    expect(msBucket(1500)).toBe('1-2s');
    expect(msBucket(45_000)).toBe('30s+');
    expect(countBucket(0)).toBe('0');
    expect(countBucket(1)).toBe('1');
    expect(countBucket(7)).toBe('6-20');
    expect(countBucket(9999)).toBe('500+');
    expect(charsBucket(60_000)).toBe('50-200k');
  });
  it('maps error codes and document kinds to fixed enums', () => {
    expect(errorCategory('rate-limit')).toBe('rate_limit');
    expect(errorCategory('cors')).toBe('network');
    expect(errorCategory('weird')).toBe('other');
    expect(docKind('pdf')).toBe('pdf');
    expect(docKind('my-resume.PDF')).toBe('pdf');
    expect(docKind('secret.xyz')).toBe('other');
    expect(optionsSection('providers?unlock=1')).toBe('providers');
    expect(optionsSection('#nope')).toBe('other');
  });
  it('accepts only allowlisted client events, keys and values', () => {
    expect(sanitizeClientEvent('nope', {})).toBeNull();
    expect(sanitizeClientEvent('toString', {})).toBeNull();
    expect(sanitizeClientEvent('popup_action', { action: 'regenerate', extra: 'x' })).toEqual({ name: 'popup_action', counter: true, props: { action: 'regenerate' } });
    expect(sanitizeClientEvent('popup_action', { action: 'my typed text' })?.props).toEqual({});
    expect(sanitizeClientEvent('form_fill_applied', { fields: 4.4, filled: 'x', trigger: 'shortcut' })).toEqual({
      name: 'form_fill_applied',
      counter: false,
      props: { fields: 4, trigger: 'shortcut' },
    });
    expect(sanitizeClientEvent('field_focused', { mode: 'icon', chat: 'yes' })?.props).toEqual({ mode: 'icon' });
  });
  it('snapshots settings as ≤ 8 valid props per event, without free text', () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.generation.customInstructions = 'TOP SECRET persona text';
    s.behavior.blockedSites = ['private.example.com'];
    const snap = settingsSnapshot(s);
    for (const [name, props] of Object.entries(snap)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]{0,47}$/);
      expect(Object.keys(props).length).toBeLessThanOrEqual(8);
      for (const [k, v] of Object.entries(props)) {
        expect(k).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
        expect(['string', 'number', 'boolean']).toContain(typeof v);
        if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(64);
      }
    }
    expect(snap.settings_generation_more?.custom_instructions).toBe(true);
    expect(snap.settings_memory?.learn).toBe('ask');
    expect(JSON.stringify(snap)).not.toMatch(/SECRET|example\.com/);
  });
});

describe('UsageReporter (richer)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    await chrome.storage.local.clear();
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.spyOn(chrome.runtime, 'getManifest').mockReturnValue({ version: '1.2.0' } as chrome.runtime.Manifest);
  });

  it('forwarded crashes keep only our frames and never the message', async () => {
    const r = new UsageReporter(() => DEFAULT_SETTINGS, fetchMock as unknown as typeof fetch);
    const stack = 'TypeError: my email is jane@doe.dev\n  second line of message\n    at f (chrome-extension://abc/content.js:1:2)\n    at g (https://bank.example/app.js:3:4)';
    await r.crash('TypeError', stack, false, 'content');
    await r.flush();
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.cr[0].m).toBe('content: TypeError');
    expect(body.cr[0].st).toContain('chrome-extension://abc/content.js');
    expect(JSON.stringify(body)).not.toMatch(/jane|bank\.example|second line/);
  });

  it('runs the async daily snapshot once a day with props', async () => {
    const r = new UsageReporter(() => DEFAULT_SETTINGS, fetchMock as unknown as typeof fetch);
    const daily = vi.fn(async () => ({ facts: { settings_memory: { learn: 'ask', embeddings: false } }, setup: ['setup_provider'] }));
    await r.flush(daily);
    await r.flush(daily);
    expect(daily).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.e).toEqual(expect.arrayContaining([expect.objectContaining({ n: 'settings_memory', p: { learn: 'ask', embeddings: false } }), expect.objectContaining({ n: 'setup_provider' })]));
  });
});
