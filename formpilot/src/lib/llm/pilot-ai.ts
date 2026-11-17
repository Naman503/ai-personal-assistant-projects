/**
 * Which AI each pilot uses. FormPilot's own provider list (AI Providers) is for your own form
 * filling; the Autopilot and Site Pilot each pick their own:
 *   cloud-then-local: the cloud model (Gemini by default), and the local model when the cloud one
 *                     is rate-limited, out of its daily quota, or down;
 *   cloud:            the cloud model only;
 *   local:            the local model only (Ollama).
 * The pilot that sent a request is known from the window it came from.
 */
import { providerConfigured, type ProviderConfig, type Settings } from '../settings';

export type Pilot = 'autopilot' | 'sitePilot';
export const PILOT_NAME: Record<Pilot, string> = { autopilot: 'Autopilot', sitePilot: 'Site Pilot' };

/** Providers a pilot can use as its main model: your configured ones except Ollama and Chrome's built-in AI (the local model is set separately). */
export function cloudProviders(s: Settings): ProviderConfig[] {
  return s.providers.filter((p) => providerConfigured(p) && p.kind !== 'ollama' && p.kind !== 'chrome-ai');
}

/** The local model as a provider: your Ollama provider's address, or Site Pilot's. */
export function localProvider(s: Settings, model: string): ProviderConfig {
  const sp = s.sitePilot;
  const ollama = s.providers.find((p) => p.kind === 'ollama' && p.baseUrl);
  // Site Pilot's own local server (also how the tests point it at a mock) wins when it's set.
  const kind = sp.kind;
  const baseUrl = kind === 'ollama' ? ollama?.baseUrl || sp.baseUrl : sp.baseUrl;
  return { id: 'pilot-local', kind, label: `Local (${model})`, enabled: true, apiKey: '', hasKey: false, baseUrl, model, jsonMode: true, headers: {}, altModels: '', rpm: 0 };
}

export function pilotProviders(s: Settings, who: Pilot): ProviderConfig[] {
  const c = s.pilotAi[who];
  const model = c.localModel.trim() || s.sitePilot.model;
  const local = localProvider(s, model);
  const clouds = cloudProviders(s);
  const cloud = clouds.find((p) => p.id === c.cloud) ?? clouds.find((p) => p.kind === 'gemini') ?? clouds[0];
  if (c.mode === 'local' || !cloud) return [local];
  if (c.mode === 'cloud') return [cloud];
  return [cloud, local];
}

/** Settings for one pilot's AI calls: its own providers, falling back down the list. */
export function pilotSettings(s: Settings, who: Pilot): Settings {
  return { ...s, providers: pilotProviders(s, who), privacy: { ...s.privacy, localOnly: false }, generation: { ...s.generation, fallback: true } };
}

/** "Gemini 3 Flash, then gemma4:12b" for the settings pages. */
export function describePilotAi(s: Settings, who: Pilot): string {
  return pilotProviders(s, who)
    .map((p) => (p.kind === 'ollama' || p.id === 'pilot-local' ? `local ${p.model}` : `${p.label} (${p.model})`))
    .join(', then ');
}
