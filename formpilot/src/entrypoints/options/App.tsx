import { useEffect, useState, type ComponentType } from 'react';
import { Toaster } from 'sonner';
import {
  LayoutDashboard,
  Cpu,
  SlidersHorizontal,
  Brain,
  MousePointerClick,
  Zap,
  ShieldCheck,
  Palette,
  ScrollText,
  Sparkles,
  Check,
  Loader2,
  AlertCircle,
  HardDrive,
  Info,
  Mail,
} from 'lucide-react';
import { useApplyAppearance, useSettings } from '@/hooks/useSettings';
import { cn } from '@/components/ui/cn';
import type { Settings } from '@/lib/settings';
import { AUTHOR } from '@/lib/about';
import { Overview } from './pages/Overview';
import { Providers } from './pages/Providers';
import { Generation } from './pages/Generation';
import { Memory } from './pages/Memory';
import { Behavior } from './pages/Behavior';
import { CacheHistory } from './pages/CacheHistory';
import { Privacy } from './pages/Privacy';
import { Appearance } from './pages/Appearance';
import { Logs } from './pages/Logs';
import { LocalModels } from './pages/LocalModels';
import { About, Avatar } from './pages/About';
import { VaultProvider } from './vault-ui';

export interface PageProps {
  settings: Settings;
  update: (fn: (d: Settings) => void) => void;
  go: (id: string) => void;
}

const NAV: { id: string; label: string; icon: ComponentType<{ className?: string }>; page: ComponentType<PageProps>; group: string }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, page: Overview, group: 'General' },
  { id: 'providers', label: 'AI Providers', icon: Cpu, page: Providers, group: 'General' },
  { id: 'local', label: 'Local Models', icon: HardDrive, page: LocalModels, group: 'General' },
  { id: 'memory', label: 'Memory', icon: Brain, page: Memory, group: 'General' },
  { id: 'generation', label: 'Generation', icon: SlidersHorizontal, page: Generation, group: 'Tuning' },
  { id: 'behavior', label: 'Behavior', icon: MousePointerClick, page: Behavior, group: 'Tuning' },
  { id: 'cache', label: 'Speed & History', icon: Zap, page: CacheHistory, group: 'Tuning' },
  { id: 'privacy', label: 'Privacy & Data', icon: ShieldCheck, page: Privacy, group: 'System' },
  { id: 'appearance', label: 'Appearance', icon: Palette, page: Appearance, group: 'System' },
  { id: 'logs', label: 'Logs & Diagnostics', icon: ScrollText, page: Logs, group: 'System' },
  { id: 'about', label: 'About', icon: Info, page: About, group: 'System' },
];

function useHashRoute(): [string, (id: string) => void] {
  const read = () => location.hash.replace('#', '').split('?')[0] || 'overview';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return [route, (id) => (location.hash = id)];
}

export function App() {
  const { settings, update, loaded, save } = useSettings();
  const [route, go] = useHashRoute();
  useApplyAppearance(settings);
  const current = NAV.find((n) => n.id === route) ?? NAV[0];
  const Page = current.page;
  const groups = [...new Set(NAV.map((n) => n.group))];

  useEffect(() => {
    document.title = `${current.label} · FormPilot`;
    window.scrollTo({ top: 0 });
  }, [current.label]);

  return (
    <VaultProvider>
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-zinc-200/80 bg-white/60 px-3 py-5 backdrop-blur md:flex dark:border-zinc-800/80 dark:bg-zinc-900/40">
        <div className="mb-6 flex items-center gap-2.5 px-2">
          <div className="grid size-8 place-items-center rounded-xl bg-gradient-to-br from-brand to-fuchsia-500 text-white shadow-md shadow-brand/30">
            <Sparkles className="size-4" />
          </div>
          <div>
            <div className="text-[15px] leading-none font-semibold tracking-tight">FormPilot</div>
            <div className="mt-1 text-[11px] text-zinc-500">AI form filling, grounded in you</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto">
          {groups.map((g) => (
            <div key={g}>
              <div className="mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">{g}</div>
              {NAV.filter((n) => n.group === g).map((n) => (
                <button
                  key={n.id}
                  onClick={() => go(n.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100',
                    route === n.id && 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800/80 dark:text-zinc-50',
                  )}
                >
                  <n.icon className={cn('size-4', route === n.id ? 'text-brand' : 'text-zinc-400')} />
                  {n.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="group mx-1 mb-1 flex items-center gap-2.5 rounded-xl border border-zinc-200/80 bg-white/80 p-2 pr-1.5 shadow-xs transition hover:border-brand/30 dark:border-zinc-800 dark:bg-zinc-900/70">
          <button onClick={() => go('about')} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" title="About FormPilot">
            <Avatar />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-200">{AUTHOR.name}</span>
              <span className="block truncate text-[11px] text-zinc-500">Developer · About</span>
            </span>
          </button>
          <a
            href={`mailto:${AUTHOR.email}`}
            title={`Email ${AUTHOR.email}`}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-400 transition hover:bg-brand/10 hover:text-brand"
          >
            <Mail className="size-4" />
          </a>
        </div>
        <div className="flex items-center gap-2 px-2.5 pt-3 text-xs text-zinc-500">
          {save === 'saving' ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Saving…
            </>
          ) : save === 'error' ? (
            <>
              <AlertCircle className="size-3.5 text-red-500" /> Save failed
            </>
          ) : (
            <>
              <Check className="size-3.5 text-emerald-500" /> All changes saved
            </>
          )}
          <span className="ml-auto font-mono">v{chrome.runtime.getManifest().version}</span>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {/* Mobile nav */}
        <div className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-zinc-200 bg-white/80 px-3 py-2 backdrop-blur md:hidden dark:border-zinc-800 dark:bg-zinc-900/80">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => go(n.id)} className={cn('rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap', route === n.id ? 'bg-brand text-white' : 'text-zinc-500')}>
              {n.label}
            </button>
          ))}
        </div>
        <div key={current.id} className="animate-fade-up mx-auto max-w-4xl px-6 py-10 lg:px-10">
          {loaded ? <Page settings={settings} update={update} go={go} /> : <div className="h-96" />}
        </div>
      </main>
      <Toaster position="bottom-right" richColors closeButton theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'} />
    </div>
    </VaultProvider>
  );
}
