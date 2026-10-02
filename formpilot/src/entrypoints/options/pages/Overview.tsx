import { useEffect, useState } from 'react';
import { Brain, CheckCircle2, Circle, Cpu, FileText, History, Keyboard, Sparkles, Zap, ArrowRight, MousePointerClick } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Kbd, PageHeader } from '@/components/ui';
import { rpc, type Stats } from '@/lib/messages';
import { providerConfigured } from '@/lib/settings';
import type { PageProps } from '../App';

export function Overview({ settings, go }: PageProps) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [commands, setCommands] = useState<chrome.commands.Command[]>([]);
  useEffect(() => {
    rpc<Stats>({ type: 'stats' }).then(setStats).catch(() => {});
    chrome.commands?.getAll?.().then(setCommands).catch(() => {});
  }, []);

  const configured = settings.providers.filter(providerConfigured);
  const hasCloud = configured.some((p) => p.kind !== 'chrome-ai');
  const steps = [
    { done: hasCloud, label: 'Connect an AI provider', hint: 'A free Gemini, Groq or OpenRouter key takes 30 seconds.', go: 'providers' },
    { done: (stats?.docs ?? 0) > 0, label: 'Add your memory', hint: 'Upload a resume, profile doc or notes so answers are about you.', go: 'memory' },
    { done: (stats?.facts ?? 0) > 0, label: 'Review your key facts', hint: 'Facts like your email fill instantly without an AI call.', go: 'memory' },
    { done: (stats?.counters.accepted ?? 0) > 0, label: 'Fill your first field', hint: 'Click into any form field on a website.', go: '' },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  const kpis = [
    { label: 'Documents', value: stats?.docs, icon: FileText },
    { label: 'Key facts', value: stats?.facts, icon: Brain },
    { label: 'Learned answers', value: stats?.history, icon: History },
    { label: 'Cached responses', value: stats?.cache, icon: Zap },
  ];

  const shortcut = (name: string, fallback: string) => commands.find((c) => c.name === name)?.shortcut || fallback;

  return (
    <>
      <PageHeader title="Overview" description="FormPilot suggests answers right under any form field, grounded in your own documents." />

      <Card className="relative mb-6 overflow-hidden">
        <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-brand/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-5 p-6">
          <div className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-brand to-fuchsia-500 text-white shadow-lg shadow-brand/30">
            <Sparkles className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">{settings.behavior.enabled ? 'FormPilot is active' : 'FormPilot is paused'}</h2>
              <Badge tone={settings.behavior.enabled ? 'green' : 'amber'}>{settings.behavior.enabled ? 'On' : 'Paused'}</Badge>
            </div>
            <p className="mt-1 text-sm text-zinc-500">
              {configured.length
                ? `Using ${configured.map((p) => p.label).join(' → ')}${settings.generation.fallback && configured.length > 1 ? ' (automatic fallback)' : ''}.`
                : 'No AI provider configured yet.'}
            </p>
          </div>
          <Button variant="primary" size="md" onClick={() => go('providers')}>
            <Cpu className="size-4" /> Manage providers
          </Button>
        </div>
      </Card>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} className="p-4">
            <div className="flex items-center justify-between text-zinc-400">
              <span className="text-xs font-medium text-zinc-500">{k.label}</span>
              <k.icon className="size-4" />
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{k.value ?? '–'}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Get set up" description={`${doneCount} of ${steps.length} done`} icon={<CheckCircle2 className="size-4" />} />
          <div className="p-2">
            {steps.map((s) => (
              <button
                key={s.label}
                onClick={() => s.go && go(s.go)}
                className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              >
                {s.done ? <CheckCircle2 className="size-5 shrink-0 text-emerald-500" /> : <Circle className="size-5 shrink-0 text-zinc-300 dark:text-zinc-600" />}
                <div className="min-w-0 flex-1">
                  <div className={`text-sm font-medium ${s.done ? 'text-zinc-400 line-through' : ''}`}>{s.label}</div>
                  <div className="text-[13px] text-zinc-500">{s.hint}</div>
                </div>
                {s.go && <ArrowRight className="size-4 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-500" />}
              </button>
            ))}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="How to use it" icon={<Keyboard className="size-4" />} />
          <div className="space-y-3 p-5 text-[13px]">
            <div className="flex items-start gap-3">
              <MousePointerClick className="mt-0.5 size-4 text-zinc-400" />
              <span>
                <b className="font-medium">Click into a field.</b> Suggestions appear underneath, like a password manager.
              </span>
            </div>
            {[
              ['Show suggestions', shortcut('open-suggestions', 'Alt+J')],
              ['Fill the whole form', shortcut('fill-form', 'Alt+Shift+J')],
              ['Navigate / insert', '↑ ↓ · Enter'],
              ['Close', 'Esc'],
            ].map(([a, k]) => (
              <div key={a} className="flex items-center justify-between">
                <span className="text-zinc-600 dark:text-zinc-400">{a}</span>
                <span className="flex gap-1">
                  {k.split(' · ').map((x) => (
                    <Kbd key={x}>{x}</Kbd>
                  ))}
                </span>
              </div>
            ))}
            <Button variant="ghost" className="mt-2 -ml-2" onClick={() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
              Customize shortcuts <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </Card>
      </div>

      {stats && (
        <p className="mt-6 text-center text-xs text-zinc-400">
          This session: {stats.counters.requests} requests · {stats.counters.instantHits} instant · {stats.counters.cacheHits} cached · {stats.counters.llmCalls} AI calls ·{' '}
          {stats.counters.accepted} inserted
        </p>
      )}
    </>
  );
}
