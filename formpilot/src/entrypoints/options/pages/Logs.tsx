import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Pause, Play, Trash2, Bug, Download } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Input, PageHeader, Row, Segmented, Switch } from '@/components/ui';
import { cn } from '@/components/ui/cn';
import { rpc } from '@/lib/messages';
import type { LogEntry, LogLevel } from '@/lib/logger';
import { activeProviders } from '@/lib/llm/registry';
import type { PageProps } from '../App';

const TONE: Record<LogLevel, string> = {
  debug: 'text-zinc-400',
  info: 'text-sky-600 dark:text-sky-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
};

export function Logs({ settings, update }: PageProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<'all' | LogLevel>('all');
  const [nano, setNano] = useState('…');

  useEffect(() => {
    const load = () => rpc<LogEntry[]>({ type: 'get-logs' }).then(setLogs).catch(() => {});
    void load();
    rpc<string>({ type: 'chrome-ai-status' }).then(setNano).catch(() => setNano('error'));
    if (!live) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [live]);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    const rank = { debug: 0, info: 1, warn: 2, error: 3 } as const;
    return logs
      .filter((l) => level === 'all' || rank[l.level] >= rank[level])
      .filter((l) => !f || `${l.ns} ${l.msg} ${JSON.stringify(l.data ?? '')}`.toLowerCase().includes(f))
      .reverse();
  }, [logs, filter, level]);

  const diagnostics = () =>
    JSON.stringify(
      {
        version: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
        chromeAi: nano,
        providers: activeProviders(settings).map((p) => ({ label: p.label, kind: p.kind, model: p.model, baseUrl: p.baseUrl, hasKey: !!p.apiKey })),
        settings: { ...settings, providers: undefined },
        recentLogs: logs.slice(-200),
      },
      null,
      2,
    );

  return (
    <>
      <PageHeader
        title="Logs & Diagnostics"
        description="Live log from the background worker, plus warnings and errors forwarded from web pages. Full content-script logs are in each page's DevTools console (filter: FormPilot)."
      />

      <Card className="mb-5">
        <CardHeader icon={<Bug className="size-4" />} title="Logging" />
        <Row label="Console log level" description="Debug shows every step: field detection, retrieval, prompts, timings.">
          <Segmented
            value={settings.debug.logLevel}
            onChange={(v) => update((d) => void (d.debug.logLevel = v))}
            options={(['debug', 'info', 'warn', 'error'] as const).map((l) => ({ value: l, label: l[0].toUpperCase() + l.slice(1) }))}
          />
        </Row>
        <Row label="Write to DevTools console">
          <Switch checked={settings.debug.console} onCheckedChange={(v) => update((d) => void (d.debug.console = v))} />
        </Row>
        <Row label="Diagnostics" description={`Chrome AI: ${nano} · ${activeProviders(settings).length} active provider(s)`}>
          <Button
            onClick={async () => {
              await navigator.clipboard.writeText(diagnostics());
              toast.success('Diagnostics copied (API keys excluded)');
            }}
          >
            <Copy className="size-3.5" /> Copy diagnostics
          </Button>
        </Row>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/80">
          <Input className="h-8 w-60" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Segmented
            value={level}
            onChange={setLevel}
            options={[
              { value: 'all', label: 'All' },
              { value: 'info', label: 'Info+' },
              { value: 'warn', label: 'Warn+' },
              { value: 'error', label: 'Errors' },
            ]}
          />
          <div className="ml-auto flex gap-1">
            <Button size="icon-sm" variant="ghost" onClick={() => setLive((l) => !l)} title={live ? 'Pause' : 'Resume'}>
              {live ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Download"
              onClick={() => {
                const url = URL.createObjectURL(new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' }));
                Object.assign(document.createElement('a'), { href: url, download: 'formpilot-logs.json' }).click();
              }}
            >
              <Download className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Clear"
              onClick={async () => {
                await rpc({ type: 'clear-logs' });
                setLogs([]);
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="max-h-[560px] overflow-auto bg-zinc-50/50 font-mono text-[12px] dark:bg-zinc-950/40">
          {shown.length === 0 ? (
            <div className="p-8 text-center font-sans text-sm text-zinc-500">No log entries yet. Focus a form field on any site to see activity.</div>
          ) : (
            shown.map((l, i) => (
              <div key={i} className="flex gap-3 border-b border-zinc-100 px-4 py-1.5 hover:bg-white dark:border-zinc-800/50 dark:hover:bg-zinc-900">
                <span className="shrink-0 text-zinc-400 tabular-nums">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
                <span className={cn('w-10 shrink-0 font-semibold uppercase', TONE[l.level])}>{l.level}</span>
                <Badge className="h-fit shrink-0 font-mono">{l.ns}</Badge>
                <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                  {l.msg}
                  {l.data !== undefined && <span className="text-zinc-400"> {typeof l.data === 'string' ? l.data : JSON.stringify(l.data)}</span>}
                </span>
                {l.ctx.startsWith('content') && <span className="shrink-0 text-zinc-400">{l.ctx.replace('content:', '')}</span>}
              </div>
            ))
          )}
        </div>
      </Card>
    </>
  );
}
