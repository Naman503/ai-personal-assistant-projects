import { isLocalProvider, providerConfigured } from '@/lib/settings-core';
import type { Settings } from '@/lib/settings';

/** How many providers could answer right now (mirrors the background's activeProviders). */
export function activeProvidersCount(s: Settings): number {
  return s.providers.filter((p) => providerConfigured(p) && (!s.privacy.localOnly || isLocalProvider(p))).length;
}
