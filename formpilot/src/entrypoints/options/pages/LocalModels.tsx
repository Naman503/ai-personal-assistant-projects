import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, Cpu, Download, ExternalLink, HardDrive, Loader2, Play, RefreshCw, Search, Trash2, X, Laptop, Sparkles, Gauge } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Empty, Input, PageHeader, Switch } from '@/components/ui';
import { cn } from '@/components/ui/cn';
import { LOCAL_MODELS, fmtContext, normTag, type LocalModel } from '@/lib/llm/catalog';
import { ollamaDelete, ollamaPull, ollamaVersion, type PullProgress } from '@/lib/llm/ollama-admin';
import { rpc } from '@/lib/messages';
import { providerFromPreset } from '@/lib/settings-core';
import type { ModelInfo } from '@/lib/llm/types';
import { formatBytes } from '@/lib/util';
import type { PageProps } from '../App';

type Filter = 'all' | LocalModel['tags'][number];

function Meter({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-zinc-500">
      <span className="w-12">{label}</span>
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={cn('h-1.5 w-3.5 rounded-full', i <= value ? 'bg-brand' : 'bg-zinc-200 dark:bg-zinc-700')} />
        ))}
      </div>
    </div>
  );
}

export function LocalModels({ settings, update, go }: PageProps) {
  const ollamaIdx = settings.providers.findIndex((p) => p.kind === 'ollama');
  const ollama = settings.providers[ollamaIdx];
  const base = ollama?.baseUrl || 'http://localhost:11434';
  const [version, setVersion] = useState<string | null | 'checking'>('checking');
  const [installed, setInstalled] = useState<ModelInfo[]>([]);
  const [progress, setProgress] = useState<Record<string, PullProgress>>({});
  const aborts = useRef<Record<string, AbortController>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [fits, setFits] = useState(false);
  const [q, setQ] = useState('');
  const [custom, setCustom] = useState('');
  const ram = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

  const refresh = useCallback(async () => {
    setVersion('checking');
    try {
      setVersion(await ollamaVersion(base, AbortSignal.timeout(4000)));
      const p = ollama ?? providerFromPreset('ollama');
      setInstalled(await rpc<ModelInfo[]>({ type: 'list-models', providerId: p.id, provider: { ...p, baseUrl: base } }));
    } catch {
      setVersion(null);
      setInstalled([]);
    }
  }, [base, ollama]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ensureProvider = (model?: string) =>
    update((d) => {
      const i = d.providers.findIndex((p) => p.kind === 'ollama');
      if (i < 0) d.providers.push(providerFromPreset('ollama', { model: model ?? 'llama3.2' }));
      else {
        d.providers[i].enabled = true;
        if (model) d.providers[i].model = model;
      }
    });

  const install = useCallback(
    async (tag: string) => {
      if (aborts.current[tag]) return;
      const ctl = new AbortController();
      aborts.current[tag] = ctl;
      setProgress((p) => ({ ...p, [tag]: { status: 'starting' } }));
      try {
        await ollamaPull(base, tag, (pr) => setProgress((p) => ({ ...p, [tag]: pr })), ctl.signal);
        toast.success(`${tag} installed`, { action: { label: 'Use it', onClick: () => ensureProvider(tag) } });
        await refresh();
      } catch (e) {
        if ((e as Error).name !== 'AbortError') toast.error(`Install failed: ${(e as Error).message}`);
      } finally {
        delete aborts.current[tag];
        setProgress((p) => {
          const n = { ...p };
          delete n[tag];
          return n;
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, refresh],
  );

  // Deep link from the model picker: #local?install=qwen2.5:7b
  useEffect(() => {
    const m = location.hash.match(/install=([^&]+)/);
    if (m && version && version !== 'checking') {
      const tag = decodeURIComponent(m[1]);
      history.replaceState(null, '', '#local');
      void install(tag);
    }
  }, [version, install]);

  const installedSet = useMemo(() => new Set(installed.map((m) => normTag(m.id))), [installed]);
  const catalog = useMemo(() => {
    const t = q.toLowerCase();
    return LOCAL_MODELS.filter((m) => filter === 'all' || m.tags.includes(filter))
      .filter((m) => !fits || !ram || m.ramGB <= ram * 1.5)
      .filter((m) => !t || `${m.tag} ${m.name} ${m.maker} ${m.notes}`.toLowerCase().includes(t));
  }, [filter, fits, q, ram]);

  const running = version && version !== 'checking';

  return (
    <>
      <PageHeader
        title="Local Models"
        description="Run AI entirely on your computer: free, private, offline. Install open models through Ollama with one click, then pick them as your provider."
        actions={
          <Button onClick={refresh}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        }
      />

      <div className="mb-5 grid gap-3 md:grid-cols-3">
        <Card className="p-4 md:col-span-2">
          <div className="flex items-start gap-3">
            <div className={cn('grid size-10 place-items-center rounded-xl', running ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600')}>
              <Laptop className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold">Ollama</span>
                {version === 'checking' ? <Badge>Checking…</Badge> : running ? <Badge tone="green">Running · v{version}</Badge> : <Badge tone="amber">Not running</Badge>}
                {ollama?.enabled && running && <Badge tone="brand">Active provider</Badge>}
              </div>
              <div className="mt-0.5 font-mono text-xs text-zinc-500">{base}</div>
              {!running && version !== 'checking' && (
                <p className="mt-2 text-[13px] text-zinc-600 dark:text-zinc-400">
                  Install Ollama from{' '}
                  <a className="text-brand hover:underline" href="https://ollama.com/download" target="_blank" rel="noreferrer">
                    ollama.com/download
                  </a>{' '}
                  and open it (or run <code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">ollama serve</code>). FormPilot handles the browser-origin setup for you.
                </p>
              )}
            </div>
            {running && !ollama?.enabled && (
              <Button variant="primary" onClick={() => ensureProvider(installed[0]?.id)}>
                <Play className="size-3.5" /> Use Ollama
              </Button>
            )}
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Gauge className="size-4 text-brand" /> This device
          </div>
          <div className="mt-2 space-y-1 text-[13px] text-zinc-600 dark:text-zinc-400">
            <div>CPU threads: {navigator.hardwareConcurrency || '?'}</div>
            <div>RAM: {ram ? `${ram >= 8 ? '8+' : ram} GB (browser reports at most 8)` : 'unknown'}</div>
            <div className="text-xs text-zinc-400">Rule of thumb: free RAM ≈ model size + 2 GB. Apple Silicon shares RAM with the GPU, which works great.</div>
          </div>
        </Card>
      </div>

      <Card className="mb-5">
        <CardHeader icon={<HardDrive className="size-4" />} title="Installed models" description={running ? `${installed.length} model${installed.length === 1 ? '' : 's'} on this machine` : 'Start Ollama to see installed models.'} />
        {installed.length === 0 ? (
          <Empty icon={<HardDrive className="size-5" />} title={running ? 'No models installed yet' : 'Ollama is not running'} description={running ? 'Install one from the catalog below. qwen2.5:7b is a great start.' : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-xs text-zinc-500">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <th className="px-5 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium">Params</th>
                  <th className="px-3 py-2 font-medium">Quant</th>
                  <th className="px-3 py-2 font-medium">Family</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {installed.map((m) => {
                  const inUse = ollama?.enabled && normTag(ollama.model) === normTag(m.id);
                  return (
                    <tr key={m.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                      <td className="px-5 py-2.5 font-mono font-medium">
                        {m.id} {inUse && <Badge tone="brand">In use</Badge>}
                      </td>
                      <td className="px-3">{m.params ?? '–'}</td>
                      <td className="px-3 font-mono text-xs">{m.quant ?? '–'}</td>
                      <td className="px-3">{m.family ?? '–'}</td>
                      <td className="px-3 tabular-nums">{m.size ? formatBytes(m.size) : '–'}</td>
                      <td className="px-3 text-zinc-500">{m.modified ? new Date(m.modified).toLocaleDateString() : '–'}</td>
                      <td className="px-3 text-right whitespace-nowrap">
                        {!inUse && (
                          <Button size="sm" variant="subtle" onClick={() => (ensureProvider(m.id), toast.success(`Using ${m.id}`))}>
                            Use
                          </Button>
                        )}
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="ml-1 hover:text-red-600"
                          title="Delete from disk"
                          onClick={async () => {
                            if (!confirm(`Delete ${m.id} from disk${m.size ? ` (frees ${formatBytes(m.size)})` : ''}?`)) return;
                            try {
                              await ollamaDelete(base, m.id);
                              toast.success(`Deleted ${m.id}`);
                              void refresh();
                            } catch (e) {
                              toast.error((e as Error).message);
                            }
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mb-5">
        <CardHeader
          icon={<Cpu className="size-4" />}
          title="Model catalog"
          description="Popular open models that work well with FormPilot. Sizes are the default 4-bit downloads."
          actions={
            <a className="inline-flex items-center gap-1 text-[13px] text-brand hover:underline" href="https://ollama.com/library" target="_blank" rel="noreferrer">
              Full library <ExternalLink className="size-3" />
            </a>
          }
        />
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-5 py-3 dark:border-zinc-800/80">
          <div className="relative">
            <Search className="absolute top-2.5 left-2.5 size-4 text-zinc-400" />
            <Input className="h-9 w-56 pl-8" placeholder="Search models" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {(['all', 'recommended', 'tiny', 'reasoning', 'multilingual', 'vision', 'long-context'] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={cn('rounded-md px-2.5 py-1 text-xs font-medium capitalize', filter === f ? 'bg-brand text-white' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800')}>
              {f.replace('-', ' ')}
            </button>
          ))}
          {ram && (
            <label className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
              <Switch checked={fits} onCheckedChange={setFits} /> Fits my RAM
            </label>
          )}
        </div>
        <div className="grid gap-3 p-4 md:grid-cols-2">
          {catalog.map((m) => {
            const isInstalled = installedSet.has(normTag(m.tag));
            const pr = progress[m.tag];
            return (
              <div key={m.tag} className={cn('flex flex-col rounded-xl border p-4 transition', isInstalled ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-zinc-200 dark:border-zinc-800')}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold">{m.name}</span>
                      {m.tags.includes('recommended') && (
                        <Badge tone="brand">
                          <Sparkles className="size-3" /> Recommended
                        </Badge>
                      )}
                    </div>
                    <div className="font-mono text-xs text-zinc-500">{m.tag}</div>
                  </div>
                  {isInstalled ? (
                    <Button size="sm" variant="subtle" onClick={() => (ensureProvider(m.tag), toast.success(`Using ${m.tag}`))}>
                      <Check className="size-3.5" /> Use
                    </Button>
                  ) : pr ? (
                    <Button size="sm" variant="ghost" onClick={() => aborts.current[m.tag]?.abort()}>
                      <X className="size-3.5" /> Cancel
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" disabled={!running} onClick={() => install(m.tag)} title={running ? `ollama pull ${m.tag}` : 'Start Ollama first'}>
                      <Download className="size-3.5" /> Install
                    </Button>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-zinc-600 dark:text-zinc-400">
                  <div>
                    <span className="text-zinc-400">Params</span> {m.params}
                  </div>
                  <div>
                    <span className="text-zinc-400">Download</span> ≈{m.sizeGB} GB
                  </div>
                  <div>
                    <span className="text-zinc-400">Context</span> {fmtContext(m.context)}
                  </div>
                  <div>
                    <span className="text-zinc-400">RAM</span> {m.ramGB}+ GB
                  </div>
                  <div>
                    <span className="text-zinc-400">By</span> {m.maker}
                  </div>
                  <div className="truncate" title={m.license}>
                    <span className="text-zinc-400">License</span> {m.license}
                  </div>
                </div>
                <div className="mt-2 flex gap-4">
                  <Meter value={m.speed} label="Speed" />
                  <Meter value={m.quality} label="Quality" />
                </div>
                <p className="mt-2 text-[12.5px] text-zinc-500">{m.notes}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {m.tags
                    .filter((t) => t !== 'recommended')
                    .map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  {ram && m.ramGB > ram * 1.5 && <Badge tone="amber">May not fit</Badge>}
                </div>
                {pr && (
                  <div className="mt-3">
                    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                      <div className="h-full bg-brand transition-[width]" style={{ width: `${Math.round((pr.ratio ?? 0) * 100)}%` }} />
                    </div>
                    <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
                      <span className="flex items-center gap-1">
                        <Loader2 className="size-3 animate-spin" /> {pr.status}
                      </span>
                      {pr.total ? (
                        <span className="tabular-nums">
                          {formatBytes(pr.completed ?? 0)} / {formatBytes(pr.total)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <form
          className="flex gap-2 border-t border-zinc-100 px-5 py-3 dark:border-zinc-800/80"
          onSubmit={(e) => {
            e.preventDefault();
            if (custom.trim()) void install(custom.trim());
            setCustom('');
          }}
        >
          <Input className="font-mono text-[13px]" placeholder="Install any model by name, e.g. qwen2.5:1.5b or hf.co/user/model-GGUF" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <Button type="submit" disabled={!running || !custom.trim()}>
            <Download className="size-3.5" /> Install
          </Button>
        </form>
        {Object.entries(progress)
          .filter(([tag]) => !LOCAL_MODELS.some((m) => m.tag === tag))
          .map(([tag, pr]) => (
            <div key={tag} className="px-5 pb-3 text-xs text-zinc-500">
              <span className="font-mono">{tag}</span>: {pr.status} {pr.ratio !== undefined ? `${Math.round(pr.ratio * 100)}%` : ''}
            </div>
          ))}
      </Card>

      <Card>
        <CardHeader icon={<Laptop className="size-4" />} title="Other local options" />
        <div className="grid gap-3 p-4 md:grid-cols-2">
          <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="font-semibold">Chrome built-in AI (Gemini Nano)</div>
            <p className="mt-1 text-[13px] text-zinc-500">About 2 GB, managed by Chrome itself. Chrome 138+ on desktop; not in Brave.</p>
            <Button className="mt-3" onClick={() => go('providers')}>
              Set up in Providers
            </Button>
          </div>
          <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="font-semibold">LM Studio</div>
            <p className="mt-1 text-[13px] text-zinc-500">Download GGUF models in the LM Studio app, start its local server (port 1234), then add the “LM Studio” provider.</p>
            <a className="mt-3 inline-flex items-center gap-1 text-[13px] text-brand hover:underline" href="https://lmstudio.ai" target="_blank" rel="noreferrer">
              lmstudio.ai <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
      </Card>
    </>
  );
}
