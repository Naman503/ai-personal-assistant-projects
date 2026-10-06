import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import {
  backgroundDek,
  changePassword,
  createVault,
  deleteSecret,
  getSecret,
  lockVault,
  passwordProblem,
  resetVault,
  resolveStoredKey,
  setSecret,
  setVaultMode,
  unlockVault,
  vaultStatus,
  VaultLockedError,
  WrongPasswordError,
  TooManyAttemptsError,
  MAX_ATTEMPTS,
  unlockCooldown,
  _clearVaultCache,
} from '@/lib/vault';
import { resolveProvider, generateWithFallback } from '@/lib/llm/registry';
import { DEFAULTS, providerFromPreset, providerConfigured } from '@/lib/settings-core';

const FAST = { iterations: 1000 }; // production uses 600k; tests only need the same code path

beforeEach(async () => {
  await resetVault();
  _clearVaultCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('vault', () => {
  it('encrypts keys at rest: no plaintext anywhere in storage', async () => {
    const dek = await createVault('correct horse 9', 'standard', FAST);
    await setSecret(dek, 'gemini', 'AIza-super-secret-value');
    const all = JSON.stringify(await chrome.storage.local.get(null));
    expect(all).not.toContain('AIza-super-secret-value');
    expect(all).not.toContain('correct horse 9'); // the password is never stored
    expect(await getSecret(dek, 'gemini')).toBe('AIza-super-secret-value');
  });

  it('rejects a wrong password and accepts the right one', async () => {
    const dek = await createVault('Passw0rd!!', 'standard', FAST);
    await setSecret(dek, 'groq', 'gsk-123');
    await expect(unlockVault('wrong-password1')).rejects.toBeInstanceOf(WrongPasswordError);
    const again = await unlockVault('Passw0rd!!');
    expect(await getSecret(again, 'groq')).toBe('gsk-123');
  });

  it('standard mode: the background can use keys without the password', async () => {
    const dek = await createVault('Passw0rd!!', 'standard', FAST);
    await setSecret(dek, 'groq', 'gsk-123');
    _clearVaultCache();
    expect(await resolveStoredKey('groq')).toBe('gsk-123');
    expect((await vaultStatus()).usable).toBe(true);
  });

  it('strict mode: locked after a "browser restart" until the password is entered', async () => {
    const dek = await createVault('Passw0rd!!', 'strict', FAST);
    await setSecret(dek, 'groq', 'gsk-123');
    expect(await resolveStoredKey('groq')).toBe('gsk-123'); // unlocked for this session after creation
    await chrome.storage.session.clear(); // browser restart wipes session storage
    _clearVaultCache();
    expect(await backgroundDek()).toBeNull();
    await expect(resolveStoredKey('groq')).rejects.toBeInstanceOf(VaultLockedError);
    expect((await vaultStatus()).usable).toBe(false);
    await unlockVault('Passw0rd!!');
    _clearVaultCache();
    expect(await resolveStoredKey('groq')).toBe('gsk-123');
    await lockVault();
    _clearVaultCache();
    await expect(resolveStoredKey('groq')).rejects.toBeInstanceOf(VaultLockedError);
  });

  it('switching modes keeps keys readable', async () => {
    const dek = await createVault('Passw0rd!!', 'standard', FAST);
    await setSecret(dek, 'a', 'k1');
    await setVaultMode(dek, 'strict');
    expect(JSON.stringify(await chrome.storage.local.get('vaultDevice'))).toBe('{}');
    await setVaultMode(dek, 'standard');
    await chrome.storage.session.clear();
    _clearVaultCache();
    expect(await resolveStoredKey('a')).toBe('k1');
  });

  it('changing the password keeps keys and retires the old password', async () => {
    const dek = await createVault('OldPassw0rd', 'standard', FAST);
    await setSecret(dek, 'a', 'k1');
    await changePassword(dek, 'NewPassw0rd', FAST);
    await expect(unlockVault('OldPassw0rd')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(await getSecret(await unlockVault('NewPassw0rd'), 'a')).toBe('k1');
  });

  it('delete and reset', async () => {
    const dek = await createVault('Passw0rd!!', 'standard', FAST);
    await setSecret(dek, 'a', 'k1');
    await setSecret(dek, 'b', 'k2');
    await deleteSecret('a');
    expect((await vaultStatus()).keys).toEqual(['b']);
    await resetVault();
    expect(await vaultStatus()).toMatchObject({ exists: false, keys: [] });
  });

  it('password rules: a 4-digit PIN is allowed', () => {
    expect(passwordProblem('123')).toMatch(/4 characters/);
    expect(passwordProblem('1234')).toBeNull();
    expect(passwordProblem('correct horse')).toBeNull();
  });

  it('a PIN works, and repeated wrong guesses are throttled (persisted across reloads)', async () => {
    const dek = await createVault('1234', 'standard', FAST);
    await setSecret(dek, 'a', 'k1');
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await expect(unlockVault('0000')).rejects.toMatchObject({ name: 'WrongPasswordError', attemptsLeft: MAX_ATTEMPTS - i });
    }
    await expect(unlockVault('0000')).rejects.toBeInstanceOf(TooManyAttemptsError);
    // Even the right PIN must wait during the pause.
    await expect(unlockVault('1234')).rejects.toBeInstanceOf(TooManyAttemptsError);
    expect(await unlockCooldown()).toBeGreaterThan(20);
    // After the pause the right PIN works and the counter resets.
    const rec = (await chrome.storage.local.get('vaultAttempts')).vaultAttempts as { fails: number; until: number };
    await chrome.storage.local.set({ vaultAttempts: { ...rec, until: Date.now() - 1 } });
    expect(await getSecret(await unlockVault('1234'), 'a')).toBe('k1');
    expect(await unlockCooldown()).toBe(0);
  });
});

describe('provider chain with vault keys', () => {
  it('fills the key from the vault right before the request; "configured" works without the key', async () => {
    const dek = await createVault('Passw0rd!!', 'standard', FAST);
    await setSecret(dek, 'groq', 'gsk-from-vault');
    const p = { ...providerFromPreset('groq'), hasKey: true };
    expect(providerConfigured(p)).toBe(true);
    expect((await resolveProvider(p)).apiKey).toBe('gsk-from-vault');

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })));
    vi.stubGlobal('fetch', fetchMock);
    const s = structuredClone(DEFAULTS);
    s.providers = [p];
    await generateWithFallback(s, { system: 's', prompt: 'p', temperature: 0, maxTokens: 10, thinking: 'off', stream: false, signal: new AbortController().signal });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer gsk-from-vault' });
  });

  it('locked strict vault → typed "locked" error with an unlock hint', async () => {
    const dek = await createVault('Passw0rd!!', 'strict', FAST);
    await setSecret(dek, 'groq', 'gsk');
    await chrome.storage.session.clear();
    _clearVaultCache();
    const s = structuredClone(DEFAULTS);
    s.providers = [{ ...providerFromPreset('groq'), hasKey: true }];
    await expect(
      generateWithFallback(s, { system: 's', prompt: 'p', temperature: 0, maxTokens: 10, thinking: 'off', stream: false, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'locked' });
  });
});
