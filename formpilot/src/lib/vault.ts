/**
 * Password-protected vault for API keys.
 *
 * Design (all WebCrypto, nothing custom):
 *  - A random 256-bit data key (DEK) encrypts every API key with AES-GCM (fresh IV each time).
 *  - The DEK is wrapped with a key derived from the user's password (PBKDF2-SHA256, 600k iterations).
 *    The password itself is never stored; a wrong password simply fails AES-GCM authentication.
 *  - Mode "standard": a copy of the DEK is kept on this device so the extension can use keys
 *    without asking. Seeing, changing or removing keys in the UI still needs the password.
 *  - Mode "strict": no device copy. After a browser restart the vault is locked until the user
 *    enters the password once; the DEK then lives only in chrome.storage.session (in memory,
 *    not readable by content scripts, cleared when the browser closes).
 */

import { createLogger } from './logger';

const log = createLogger('vault');

export type VaultMode = 'standard' | 'strict';

interface Sealed {
  iv: string;
  ct: string;
}

interface VaultRecord {
  v: 1;
  mode: VaultMode;
  salt: string;
  iterations: number;
  /** DEK wrapped with the password-derived key. */
  wrapped: Sealed;
  createdAt: number;
  updatedAt: number;
}

export interface VaultStatus {
  exists: boolean;
  mode: VaultMode;
  /** The extension itself can use the keys right now (standard mode, or strict mode unlocked this session). */
  usable: boolean;
  /** Providers with a stored key. */
  keys: string[];
}

const K_VAULT = 'vault';
const K_DEVICE = 'vaultDevice';
const K_SECRETS = 'vaultSecrets';
const K_SESSION = 'vaultSession';
export const DEFAULT_ITERATIONS = 600_000;

// ---------- encoding helpers ----------
const enc = new TextEncoder();
const dec = new TextDecoder();
function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const u = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));

// ---------- crypto primitives ----------
async function deriveKek(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Sealed> {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: b64(iv), ct: b64(ct) };
}

async function open(key: CryptoKey, s: Sealed): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv) }, key, unb64(s.ct)));
}

const importDek = (raw: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
const exportDek = async (dek: CryptoKey) => new Uint8Array(await crypto.subtle.exportKey('raw', dek));

// ---------- storage ----------
async function getVault(): Promise<VaultRecord | null> {
  return ((await chrome.storage.local.get(K_VAULT))[K_VAULT] as VaultRecord | undefined) ?? null;
}
async function getSecrets(): Promise<Record<string, Sealed>> {
  return ((await chrome.storage.local.get(K_SECRETS))[K_SECRETS] as Record<string, Sealed> | undefined) ?? {};
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password');
    this.name = 'WrongPasswordError';
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super('FormPilot is locked. Enter your password to use your saved API keys.');
    this.name = 'VaultLockedError';
  }
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9\W_]/.test(pw)) return 'Mix letters with numbers or symbols.';
  return null;
}

/** 0–4 rough strength score for the UI meter. */
export function passwordStrength(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw) && /[^a-zA-Z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}

// ---------- public API ----------
export async function vaultStatus(): Promise<VaultStatus> {
  const v = await getVault();
  const keys = Object.keys(await getSecrets());
  if (!v) return { exists: false, mode: 'standard', usable: false, keys };
  const usable = !!(await deviceOrSessionDek());
  return { exists: true, mode: v.mode, usable, keys };
}

/** Create the vault. Returns the unlocked DEK so the caller can immediately store keys. */
export async function createVault(password: string, mode: VaultMode = 'standard', opts: { iterations?: number } = {}): Promise<CryptoKey> {
  if (await getVault()) throw new Error('A password is already set.');
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const salt = rand(16);
  const kek = await deriveKek(password, salt, iterations);
  const raw = rand(32);
  const dek = await importDek(raw);
  const now = Date.now();
  const rec: VaultRecord = { v: 1, mode, salt: b64(salt), iterations, wrapped: await seal(kek, raw), createdAt: now, updatedAt: now };
  await chrome.storage.local.set({ [K_VAULT]: rec });
  await storeUsableCopy(raw, mode);
  log.info(`vault created (${mode} mode)`);
  return dek;
}

/** Check the password and return the DEK. In strict mode this also unlocks the extension for this browser session. */
export async function unlockVault(password: string): Promise<CryptoKey> {
  const v = await getVault();
  if (!v) throw new Error('No password has been set yet.');
  const kek = await deriveKek(password, unb64(v.salt), v.iterations);
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = await open(kek, v.wrapped);
  } catch {
    throw new WrongPasswordError();
  }
  if (v.mode === 'strict') await chrome.storage.session.set({ [K_SESSION]: b64(raw) });
  return importDek(raw);
}

/** Strict mode: forget the session copy so the extension needs the password again. */
export async function lockVault(): Promise<void> {
  await chrome.storage.session.remove(K_SESSION);
}

export async function changePassword(dek: CryptoKey, newPassword: string, opts: { iterations?: number } = {}): Promise<void> {
  const v = await getVault();
  if (!v) throw new Error('No password has been set yet.');
  const iterations = opts.iterations ?? v.iterations ?? DEFAULT_ITERATIONS;
  const salt = rand(16);
  const kek = await deriveKek(newPassword, salt, iterations);
  await chrome.storage.local.set({
    [K_VAULT]: { ...v, salt: b64(salt), iterations, wrapped: await seal(kek, await exportDek(dek)), updatedAt: Date.now() } satisfies VaultRecord,
  });
  log.info('vault password changed');
}

export async function setVaultMode(dek: CryptoKey, mode: VaultMode): Promise<void> {
  const v = await getVault();
  if (!v) throw new Error('No password has been set yet.');
  await chrome.storage.local.set({ [K_VAULT]: { ...v, mode, updatedAt: Date.now() } satisfies VaultRecord });
  await storeUsableCopy(await exportDek(dek), mode);
  log.info(`vault mode → ${mode}`);
}

async function storeUsableCopy(raw: Uint8Array<ArrayBuffer>, mode: VaultMode) {
  if (mode === 'standard') {
    await chrome.storage.local.set({ [K_DEVICE]: b64(raw) });
    await chrome.storage.session.remove(K_SESSION);
  } else {
    await chrome.storage.local.remove(K_DEVICE);
    // Stay unlocked for the rest of this browser session.
    await chrome.storage.session.set({ [K_SESSION]: b64(raw) });
  }
}

/** Forget everything (e.g. forgotten password). All stored keys are deleted. */
export async function resetVault(): Promise<void> {
  await chrome.storage.local.remove([K_VAULT, K_DEVICE, K_SECRETS]);
  await chrome.storage.session.remove(K_SESSION);
  log.warn('vault reset: all stored API keys deleted');
}

export async function setSecret(dek: CryptoKey, id: string, value: string): Promise<void> {
  const secrets = await getSecrets();
  secrets[id] = await seal(dek, enc.encode(value.trim()));
  await chrome.storage.local.set({ [K_SECRETS]: secrets });
}

export async function getSecret(dek: CryptoKey, id: string): Promise<string | null> {
  const s = (await getSecrets())[id];
  if (!s) return null;
  return dec.decode(await open(dek, s));
}

export async function deleteSecret(id: string): Promise<void> {
  const secrets = await getSecrets();
  delete secrets[id];
  await chrome.storage.local.set({ [K_SECRETS]: secrets });
}

// ---------- background access (no password) ----------
let cachedDek: CryptoKey | null = null;

async function deviceOrSessionDek(): Promise<CryptoKey | null> {
  const device = (await chrome.storage.local.get(K_DEVICE))[K_DEVICE] as string | undefined;
  if (device) return importDek(unb64(device));
  const session = (await chrome.storage.session.get(K_SESSION))[K_SESSION] as string | undefined;
  if (session) return importDek(unb64(session));
  return null;
}

/** DEK for the background, or null when locked (strict mode before unlock). */
export async function backgroundDek(): Promise<CryptoKey | null> {
  if (cachedDek) return cachedDek;
  cachedDek = await deviceOrSessionDek();
  return cachedDek;
}

/** Resolve a provider's stored key for use; throws VaultLockedError when locked. */
export async function resolveStoredKey(providerId: string): Promise<string | null> {
  const secrets = await getSecrets();
  if (!secrets[providerId]) return null;
  const dek = await backgroundDek();
  if (!dek) throw new VaultLockedError();
  return dec.decode(await open(dek, secrets[providerId]));
}

/** Drop the cached DEK whenever vault storage changes (lock, unlock, mode change, reset). */
export function installVaultCacheInvalidation() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' && (K_VAULT in changes || K_DEVICE in changes)) || (area === 'session' && K_SESSION in changes)) cachedDek = null;
  });
}

/** For tests. */
export function _clearVaultCache() {
  cachedDek = null;
}
