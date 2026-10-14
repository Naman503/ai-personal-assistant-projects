import { useSyncExternalStore } from 'react';
import type { ErrorInfo, FieldContext, Suggestion, SuggestMeta } from '@/lib/types';
import type { Settings } from '@/lib/settings';
import type { SavedPos } from '@/lib/panel-position';

export type Status = 'idle' | 'instant' | 'retrieving' | 'generating' | 'streaming' | 'done' | 'error';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
  actions?: { label: string; run: () => void; primary?: boolean }[];
}

export interface UIState {
  open: boolean;
  iconVisible: boolean;
  anchor: HTMLElement | null;
  field: FieldContext | null;
  instant: Suggestion[];
  ai: Suggestion[];
  status: Status;
  error?: ErrorInfo;
  meta?: SuggestMeta;
  active: number;
  refineOpen: boolean;
  providerLabel?: string;
  hasProvider: boolean;
  filling: boolean;
  toast?: Toast;
  theme: 'light' | 'dark';
  accent: string;
  compact: boolean;
  maxWidth: number;
  reduceMotion: boolean;
  /** Popup display/behaviour settings. */
  ui: Settings['panel'];
  /** Where the user dragged the popup (null = anchored to the field). */
  manualPos: SavedPos | null;
  /** Pinned: stays on screen when focus leaves or you type. */
  pinned: boolean;
}

export function createStore(initial: UIState) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<UIState> | ((s: UIState) => Partial<UIState>)) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

export type Store = ReturnType<typeof createStore>;

export function useStore<T>(store: Store, sel: (s: UIState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}

/** Instant items first, then AI, without duplicates. */
export function visibleItems(s: UIState): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const x of [...s.instant, ...s.ai]) {
    const k = x.text.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
