import { useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronsUpDown, Download, Loader2, RefreshCw, Search, Brain, HardDrive } from 'lucide-react';
import { cn } from './ui/cn';
import { Badge } from './ui';
import type { ModelInfo } from '@/lib/llm/types';
import { PROVIDER_PRESETS, providerConfigured } from '@/lib/settings-core';
import type { ProviderConfig } from '@/lib/settings';
import { LOCAL_MODELS, fmtContext, fmtPrice, normTag } from '@/lib/llm/catalog';
import { rpc } from '@/lib/messages';
import { formatBytes } from '@/lib/util';

const TTL = 6 * 3600_000;
const cacheKey = (p: ProviderConfig) => `models:${p.id}:${p.baseUrl}`;

interface Cached {
  at: number;
  models: ModelInfo[];
}

/** Static list shown before the live list is fetched (or when the provider isn't configured yet). */
function fallbackModels(p: ProviderConfig): ModelInfo[] {
  if (p.kind === 'ollama') {
    return LOCAL_MODELS.map((m) => ({ id: m.tag, name: m.name, params: m.params, size: m.sizeGB * 1e9, context: m.context, owner: m.maker, description: m.notes, installed: false, free: true }));
  }
  const preset = PROVIDER_PRESETS.find((x) => x.presetId === p.id) ?? PROVIDER_PRESETS.find((x) => x.kind === p.kind && x.baseUrl === p.baseUrl);
  return (preset?.models ?? []).map((id) => ({ id, free: id.endsWith(':free') || id === 'openrouter/free' || undefined }));
}

/** Ollama: merge installed models with the catalog so you see what you could install too. */
function mergeOllama(live: ModelInfo[]): ModelInfo[] {
  const installed = new Set(live.map((m) => normTag(m.id)));
  const extra = LOCAL_MODELS.filter((m) => !installed.has(normTag(m.tag))).map((m) => ({
    id: m.tag,
    name: m.name,
    params: m.params,
    size: m.sizeGB * 1e9,
    context: m.context,
    owner: m.maker,
    description: m.notes,
    installed: false,
    free: true,
  }));
  return [...live.map((m) => ({ ...m, description: m.description ?? LOCAL_MODELS.find((c) => normTag(c.tag) === normTag(m.id))?.notes })), ...extra];
}

export function useModelList(p: ProviderConfig) {
  const [models, setModels] = useState<ModelInfo[]>(() => fallbackModels(p));
  const [at, setAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canFetch = p.kind === 'ollama' || p.kind === 'chrome-ai' || providerConfigured({ ...p, enabled: true });

  const refresh = async () => {
    if (!canFetch) return;
    setLoading(true);
    setError(null);
    try {
      const live = await rpc<ModelInfo[]>({ type: 'list-models', providerId: p.id, provider: p });
      const list = p.kind === 'ollama' ? mergeOllama(live) : live.length ? live : fallbackModels(p);
      setModels(list);
      const now = Date.now();
      setAt(now);
      await chrome.storage.local.set({ [cacheKey(p)]: { at: now, models: list } satisfies Cached });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    chrome.storage.local.get(cacheKey(p)).then((r) => {
      if (cancelled) return;
      const c = r[cacheKey(p)] as Cached | undefined;
      if (c?.models?.length) {
        setModels(c.models);
        setAt(c.at);
        if (Date.now() - c.at > TTL) void refresh();
      } else {
        setModels(fallbackModels(p));
        void refresh();
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id, p.baseUrl, p.kind, canFetch && p.apiKey]);

  return { models, at, loading, error, refresh, canFetch };
}

function ago(t: number | null) {
  if (!t) return 'not fetched yet';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function ModelRow({ m, selected, active }: { m: ModelInfo; selected: boolean; active: boolean }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-lg px-3 py-2.5', active && 'bg-zinc-100 dark:bg-zinc-800/80')}>
      <div className="mt-0.5 grid size-4 shrink-0 place-items-center">{selected && <Check className="size-4 text-brand" />}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[13px] font-medium">{m.id}</span>
          {m.name && m.name !== m.id && <span className="text-xs text-zinc-500">{m.name}</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {m.free && <Badge tone="green">Free</Badge>}
          {m.installed === true && <Badge tone="green">Installed</Badge>}
          {m.installed === false && <Badge tone="amber">Not installed</Badge>}
          {m.context ? <Badge tone="blue">{fmtContext(m.context)} context</Badge> : null}
          {m.maxOutput ? <Badge>{fmtContext(m.maxOutput)} out</Badge> : null}
          {m.price && !m.free && <Badge>{fmtPrice(m.price)}</Badge>}
          {m.params && <Badge>{m.params}</Badge>}
          {m.quant && <Badge>{m.quant}</Badge>}
          {m.size ? <Badge>{formatBytes(m.size)}</Badge> : null}
          {m.thinking && <Badge tone="brand">thinking</Badge>}
          {m.owner && <Badge>{m.owner}</Badge>}
        </div>
        {m.description && <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{m.description}</p>}
      </div>
    </div>
  );
}

export function ModelPicker({ provider, value, onChange, onInstall }: { provider: ProviderConfig; value: string; onChange: (id: string) => void; onInstall?: (tag: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'free' | 'installed'>('all');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { models, at, loading, error, refresh, canFetch } = useModelList(provider);

  const hasFree = models.some((m) => m.free) && provider.kind === 'openai';
  const hasInstalled = provider.kind === 'ollama';
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return models
      .filter((m) => filter === 'all' || (filter === 'free' ? m.free : m.installed))
      .filter((m) => !t || `${m.id} ${m.name ?? ''} ${m.owner ?? ''} ${m.description ?? ''}`.toLowerCase().includes(t));
  }, [models, q, filter]);
  const custom = q.trim() && !models.some((m) => m.id === q.trim()) ? q.trim() : '';
  const current = models.find((m) => m.id === value);

  useEffect(() => setActive(0), [q, filter]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (m: ModelInfo) => {
    if (m.installed === false && onInstall) {
      onInstall(m.id);
    }
    onChange(m.id);
    setOpen(false);
    setQ('');
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="flex h-9 w-80 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-left shadow-xs outline-none transition hover:border-zinc-300 focus-visible:ring-3 focus-visible:ring-brand/15 dark:border-zinc-800 dark:bg-zinc-900">
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{value || <span className="font-sans text-zinc-400">Choose a model…</span>}</span>
          {current?.free && <Badge tone="green">Free</Badge>}
          {current?.installed === false && <Badge tone="amber">Not installed</Badge>}
          <ChevronsUpDown className="size-4 shrink-0 text-zinc-400" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 flex max-h-[min(560px,var(--radix-popover-content-available-height))] w-[580px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-900/15 dark:border-zinc-800 dark:bg-zinc-900"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector('input')?.focus();
          }}
        >
          <div className="flex items-center gap-2 border-b border-zinc-100 px-3 dark:border-zinc-800">
            <Search className="size-4 text-zinc-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${models.length} models or type any model id…`}
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
              onKeyDown={(e) => {
                const max = shown.length + (custom ? 1 : 0) - 1;
                if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(max, a + 1)));
                else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
                else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (active < shown.length && shown[active]) pick(shown[active]);
                  else if (custom) pick({ id: custom });
                }
              }}
            />
            <button className="grid size-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 dark:hover:bg-zinc-800" onClick={refresh} disabled={!canFetch || loading} title="Refresh the live model list">
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            </button>
          </div>
          {(hasFree || hasInstalled) && (
            <div className="flex gap-1 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
              {(['all', hasFree ? 'free' : null, hasInstalled ? 'installed' : null].filter(Boolean) as ('all' | 'free' | 'installed')[]).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={cn('rounded-md px-2.5 py-1 text-xs font-medium capitalize', filter === f ? 'bg-brand text-white' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800')}>
                  {f} {f === 'free' ? `(${models.filter((m) => m.free).length})` : f === 'installed' ? `(${models.filter((m) => m.installed).length})` : `(${models.length})`}
                </button>
              ))}
            </div>
          )}
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {shown.map((m, i) => (
              <button key={m.id} data-idx={i} className="block w-full text-left" onMouseEnter={() => setActive(i)} onClick={() => pick(m)}>
                <ModelRow m={m} selected={m.id === value} active={i === active} />
              </button>
            ))}
            {custom && (
              <button data-idx={shown.length} className="block w-full text-left" onMouseEnter={() => setActive(shown.length)} onClick={() => pick({ id: custom })}>
                <div className={cn('rounded-lg px-3 py-2.5 text-sm', active === shown.length && 'bg-zinc-100 dark:bg-zinc-800/80')}>
                  Use custom model id <span className="font-mono font-medium">{custom}</span>
                  {provider.kind === 'ollama' && <span className="text-zinc-500"> (it will be installed from ollama.com)</span>}
                </div>
              </button>
            )}
            {!shown.length && !custom && <div className="px-3 py-8 text-center text-sm text-zinc-500">No models match.</div>}
          </div>
          <div className="flex items-center gap-2 border-t border-zinc-100 bg-zinc-50/70 px-3 py-2 text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/40">
            {provider.kind === 'ollama' ? <HardDrive className="size-3.5" /> : <Brain className="size-3.5" />}
            {error ? (
              <span className="truncate text-red-600" title={error}>
                Live list failed: {error}
              </span>
            ) : canFetch ? (
              <span>
                {shown.length} of {models.length} models · updated {ago(at)}
              </span>
            ) : (
              <span>Add an API key to load the live model list. Showing suggested models.</span>
            )}
            {provider.kind === 'ollama' && onInstall && (
              <span className="ml-auto flex items-center gap-1">
                <Download className="size-3" /> Picking a model that isn't installed starts the download
              </span>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
