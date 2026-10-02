import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, watchSettings, type Settings } from '@/lib/settings';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Settings with optimistic local updates and debounced auto-save.
 * Changes made in other contexts (popup, another tab) flow back in through storage.onChanged.
 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [save, setSave] = useState<SaveState>('idle');
  const pending = useRef<Settings | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
    return watchSettings((s) => {
      if (!pending.current) setSettings(s);
    });
  }, []);

  const flush = useCallback(async () => {
    const s = pending.current;
    if (!s) return;
    try {
      await saveSettings(s);
      setSave('saved');
    } catch {
      setSave('error');
    } finally {
      pending.current = null;
    }
  }, []);

  const update = useCallback(
    (fn: (draft: Settings) => void) => {
      setSettings((prev) => {
        const next = structuredClone(prev);
        fn(next);
        pending.current = next;
        return next;
      });
      setSave('saving');
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 350);
    },
    [flush],
  );

  useEffect(() => {
    const onUnload = () => void flush();
    addEventListener('beforeunload', onUnload);
    return () => removeEventListener('beforeunload', onUnload);
  }, [flush]);

  return { settings, update, loaded, save };
}

/** Apply theme + accent to the document root. */
export function useApplyAppearance(s: Settings) {
  useEffect(() => {
    const ACC: Record<string, string> = { violet: '#7c3aed', blue: '#2563eb', emerald: '#059669', orange: '#ea580c', rose: '#e11d48', slate: '#475569' };
    const root = document.documentElement;
    root.style.setProperty('--brand', ACC[s.appearance.accent] ?? '#7c3aed');
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => root.classList.toggle('dark', s.appearance.theme === 'dark' || (s.appearance.theme === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [s.appearance.accent, s.appearance.theme]);
}
