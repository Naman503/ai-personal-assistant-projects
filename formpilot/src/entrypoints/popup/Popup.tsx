import { useEffect, useState } from 'react';
import { Sparkles, Settings2, Brain, ListChecks, Globe, Power, Cpu, ChevronRight, ScrollText, Mail } from 'lucide-react';
import { Badge, Switch } from '@/components/ui';
import { useApplyAppearance, useSettings } from '@/hooks/useSettings';
import { siteAllowed } from '@/lib/fields/eligibility';
import { providerConfigured, isLocalProvider } from '@/lib/settings';
import { hostMatches } from '@/lib/util';
import { rpc, type Stats } from '@/lib/messages';
import { AUTHOR } from '@/lib/about';

function openOptions(section?: string) {
  void rpc({ type: 'open-options', section }).then(() => window.close());
}

export function Popup() {
  const { settings, update, loaded } = useSettings();
  useApplyAppearance(settings);
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t ?? null));
    rpc<Stats>({ type: 'stats' }).then(setStats).catch(() => {});
  }, []);

  const host = (() => {
    try {
      const u = new URL(tab?.url ?? '');
      return /^https?:$/.test(u.protocol) ? u.hostname : '';
    } catch {
      return '';
    }
  })();
  const blocked = !!host && settings.behavior.blockedSites.some((p) => hostMatches(host, p));
  const activeHere = !!host && siteAllowed(host, settings);
  const providers = settings.providers.filter((p) => providerConfigured(p) && (!settings.privacy.localOnly || isLocalProvider(p)));

  if (!loaded) return <div className="h-80" />;

  return (
    <div className="bg-white dark:bg-zinc-900">
      <div className="relative overflow-hidden px-4 pt-4 pb-3">
        <div className="pointer-events-none absolute -top-16 -right-10 size-40 rounded-full bg-brand/20 blur-3xl" />
        <div className="relative flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand to-fuchsia-500 text-white shadow-md shadow-brand/30">
            <Sparkles className="size-4" />
          </div>
          <div className="flex-1">
            <div className="text-[15px] leading-tight font-semibold tracking-tight">FormPilot</div>
            <div className="text-xs text-zinc-500">{settings.behavior.enabled ? (activeHere ? 'Active on this page' : host ? 'Paused on this page' : 'Not available on this page') : 'Paused everywhere'}</div>
          </div>
          <Switch checked={settings.behavior.enabled} onCheckedChange={(v) => update((d) => void (d.behavior.enabled = v))} />
        </div>
      </div>

      <div className="space-y-1 px-2 pb-2">
        {host && (
          <div className="flex items-center gap-3 rounded-xl px-2.5 py-2.5">
            <Globe className="size-4 text-zinc-400" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{host}</div>
              <div className="text-xs text-zinc-500">{blocked ? 'Blocked on this site' : 'Enabled on this site'}</div>
            </div>
            <Switch
              checked={!blocked}
              disabled={!settings.behavior.enabled}
              onCheckedChange={(on) =>
                update((d) => {
                  const list = d.behavior.blockedSites.filter((p) => !hostMatches(host, p));
                  d.behavior.blockedSites = on ? list : [...list, host];
                })
              }
            />
          </div>
        )}

        <button
          className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
          disabled={!activeHere || !tab?.id}
          onClick={async () => {
            if (!tab?.id) return;
            await chrome.tabs.sendMessage(tab.id, { type: 'command', name: 'fill-form' }).catch(() => {});
            window.close();
          }}
        >
          <ListChecks className="size-4 text-brand" />
          <div className="flex-1">
            <div className="text-[13px] font-medium">Fill this form</div>
            <div className="text-xs text-zinc-500">Click into the form first · Alt+Shift+J</div>
          </div>
        </button>

        <button className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => openOptions('providers')}>
          <Cpu className="size-4 text-zinc-400" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">AI provider</div>
            <div className="truncate text-xs text-zinc-500">{providers.length ? providers.map((p) => p.label).join(' → ') : 'Not configured'}</div>
          </div>
          {providers.length ? <Badge tone="green">Ready</Badge> : <Badge tone="amber">Set up</Badge>}
        </button>

        <button className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => openOptions('memory')}>
          <Brain className="size-4 text-zinc-400" />
          <div className="flex-1">
            <div className="text-[13px] font-medium">Memory</div>
            <div className="text-xs text-zinc-500">{stats ? `${stats.docs} docs · ${stats.facts} facts · ${stats.history} learned` : '…'}</div>
          </div>
          <ChevronRight className="size-4 text-zinc-300" />
        </button>
      </div>

      <div className="flex items-center gap-1 border-t border-zinc-100 px-2 py-2 dark:border-zinc-800">
        <button className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800" onClick={() => openOptions()}>
          <Settings2 className="size-3.5" /> Settings
        </button>
        <button className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800" onClick={() => openOptions('logs')}>
          <ScrollText className="size-3.5" /> Logs
        </button>
        <span className="ml-auto flex items-center gap-1 pr-2 text-[11px] text-zinc-400">
          <Power className="size-3" /> v{chrome.runtime.getManifest().version}
        </span>
      </div>
      <div className="flex items-center gap-2 border-t border-zinc-100 bg-zinc-50/80 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => openOptions('about')} title="About FormPilot">
          <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand via-fuchsia-500 to-amber-400 text-[9px] font-semibold text-white">
            {AUTHOR.initials}
          </span>
          <span className="truncate text-[11px] text-zinc-500">
            Made by <span className="font-medium text-zinc-700 dark:text-zinc-300">{AUTHOR.name}</span>
          </span>
        </button>
        <a
          href={`mailto:${AUTHOR.email}`}
          target="_blank"
          rel="noreferrer"
          title={AUTHOR.email}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-brand transition hover:bg-brand/10"
        >
          <Mail className="size-3" /> Email
        </a>
      </div>
    </div>
  );
}
