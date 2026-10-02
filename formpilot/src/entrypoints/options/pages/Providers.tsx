import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, CheckCircle2, Cpu, Download, ExternalLink, Gauge, Plus, RefreshCw, Trash2, XCircle, Laptop, Cloud, Sparkles } from 'lucide-react';
import { ModelPicker } from '@/components/ModelPicker';
import { Badge, Button, Card, CardHeader, Input, PageHeader, Row, SecretInput, Switch } from '@/components/ui';
import { cn } from '@/components/ui/cn';
import { PROVIDER_PRESETS, isLocalProvider, providerConfigured, providerFromPreset, type ProviderConfig } from '@/lib/settings';
import { rpc } from '@/lib/messages';
import { nanoAvailability, nanoDownload } from '@/lib/llm/nano';
import { uid } from '@/lib/util';
import type { PageProps } from '../App';

type TestState = { state: 'idle' | 'running' | 'ok' | 'fail'; msg?: string; ms?: number };

function presetFor(p: ProviderConfig) {
  return (
    PROVIDER_PRESETS.find((x) => x.presetId === p.id) ??
    PROVIDER_PRESETS.find((x) => x.kind === p.kind && x.baseUrl && p.baseUrl.startsWith(x.baseUrl)) ??
    PROVIDER_PRESETS.find((x) => (p.kind === 'openai' ? x.presetId === 'custom' : x.kind === p.kind))
  );
}

function ChromeAiStatus() {
  const [status, setStatus] = useState<string>('checking');
  const [pct, setPct] = useState<number | null>(null);
  // The background (offscreen document) status is what generation actually uses; the page check is a fallback.
  const check = () =>
    rpc<string>({ type: 'chrome-ai-status' })
      .catch(() => nanoAvailability())
      .then(setStatus);
  useEffect(() => {
    void check();
  }, []);
  const label: Record<string, [string, 'green' | 'amber' | 'red' | 'neutral']> = {
    available: ['Ready on this device', 'green'],
    downloadable: ['Model not downloaded', 'amber'],
    downloading: ['Downloading…', 'amber'],
    unavailable: ['Not supported on this device', 'red'],
    'no-api': ['Not available in this browser', 'red'],
    checking: ['Checking…', 'neutral'],
  };
  const [text, tone] = label[status] ?? [status, 'neutral'];
  return (
    <Row
      label="On-device model"
      description={
        status === 'no-api' || status === 'unavailable'
          ? 'Not available here, so FormPilot skips it automatically (no errors, no delay). It needs Chrome 138+ on desktop with enough disk and RAM; Brave does not ship Gemini Nano. You can turn this provider off.'
          : 'Gemini Nano runs inside Chrome: free, private and offline. The first download is about 2 GB.'
      }
    >
      <div className="flex items-center gap-2">
        <Badge tone={tone}>{pct !== null && status !== 'available' ? `${text} ${pct}%` : text}</Badge>
        {(status === 'downloadable' || status === 'downloading') && (
          <Button
            variant="primary"
            onClick={async () => {
              try {
                setPct(0);
                await nanoDownload(setPct);
                toast.success('Gemini Nano is ready');
              } catch (e) {
                toast.error(`Download failed: ${(e as Error).message}`);
              } finally {
                void check();
              }
            }}
          >
            <Download className="size-3.5" /> Download model
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={check} title="Re-check">
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
    </Row>
  );
}

function ProviderCard({
  p,
  index,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  p: ProviderConfig;
  index: number;
  total: number;
  onChange: (fn: (p: ProviderConfig) => void) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove?: () => void;
}) {
  const preset = presetFor(p);
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const ready = providerConfigured(p);
  const local = isLocalProvider(p);

  const runTest = async () => {
    setTest({ state: 'running' });
    try {
      const r = await rpc<{ ms: number; model: string }>({ type: 'test-provider', providerId: p.id, provider: p });
      setTest({ state: 'ok', ms: r.ms, msg: r.model });
    } catch (e) {
      const info = (e as Error & { info?: { hint?: string } }).info;
      setTest({ state: 'fail', msg: `${(e as Error).message}${info?.hint ? ` · ${info.hint}` : ''}` });
    }
  };


  return (
    <Card className={cn('transition', !p.enabled && 'opacity-70')}>
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="flex flex-col">
          <button className="text-zinc-300 hover:text-zinc-600 disabled:opacity-30" disabled={index === 0} onClick={() => onMove(-1)} title="Try earlier">
            <ArrowUp className="size-3.5" />
          </button>
          <button className="text-zinc-300 hover:text-zinc-600 disabled:opacity-30" disabled={index === total - 1} onClick={() => onMove(1)} title="Try later">
            <ArrowDown className="size-3.5" />
          </button>
        </div>
        <div className={cn('grid size-9 place-items-center rounded-xl', local ? 'bg-emerald-500/10 text-emerald-600' : 'bg-brand/10 text-brand')}>
          {p.kind === 'chrome-ai' ? <Sparkles className="size-4" /> : local ? <Laptop className="size-4" /> : <Cloud className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tracking-tight">{p.label}</span>
            <span className="font-mono text-xs text-zinc-400">#{index + 1}</span>
            {local ? <Badge tone="green">Local</Badge> : preset && <Badge tone={preset.free === 'free' ? 'blue' : 'neutral'}>{preset.free === 'free' ? 'Free' : 'Free tier'}</Badge>}
            {p.enabled && (ready ? <Badge tone="green">Configured</Badge> : <Badge tone="amber">Needs setup</Badge>)}
          </div>
          {preset && <p className="mt-0.5 text-[13px] text-zinc-500">{preset.blurb}</p>}
        </div>
        <Switch checked={p.enabled} onCheckedChange={(v) => onChange((d) => void (d.enabled = v))} />
      </div>

      {p.enabled && (
        <div className="border-t border-zinc-100 dark:border-zinc-800/80">
          {p.kind === 'chrome-ai' ? (
            <ChromeAiStatus />
          ) : (
            <>
              {(preset?.needsKey || p.apiKey) && (
                <Row
                  label="API key"
                  description={
                    preset?.keyUrl ? (
                      <a className="inline-flex items-center gap-1 text-brand hover:underline" href={preset.keyUrl} target="_blank" rel="noreferrer">
                        Get a free key <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      'Stored only on this device.'
                    )
                  }
                >
                  <SecretInput className="w-80" value={p.apiKey} placeholder="Paste your key" onChange={(v) => onChange((d) => void (d.apiKey = v.trim()))} />
                </Row>
              )}
              {p.kind !== 'gemini' && (
                <Row label="Base URL" description={p.kind === 'ollama' ? 'Default http://localhost:11434' : 'The /chat/completions endpoint root.'}>
                  <Input className="w-80 font-mono text-[13px]" value={p.baseUrl} onChange={(e) => onChange((d) => void (d.baseUrl = e.target.value.trim()))} />
                </Row>
              )}
              <Row label="Model" description={p.kind === 'ollama' ? 'Installed models plus the catalog. Pick one that is not installed to download it.' : 'Every model your key can use, loaded live from the provider.'}>
                <ModelPicker
                  provider={p}
                  value={p.model}
                  onChange={(id) => onChange((d) => void (d.model = id))}
                  onInstall={p.kind === 'ollama' ? (tag) => (location.hash = `local?install=${encodeURIComponent(tag)}`) : undefined}
                />
              </Row>
              {p.kind === 'openai' && (
                <Row label="JSON mode" description="Ask for strict JSON output. FormPilot retries without it automatically if the model rejects it.">
                  <Switch checked={p.jsonMode} onCheckedChange={(v) => onChange((d) => void (d.jsonMode = v))} />
                </Row>
              )}
              {p.kind === 'ollama' && (
                <div className="mx-5 mb-4 rounded-lg bg-zinc-50 px-3 py-2.5 text-[12.5px] text-zinc-500 dark:bg-zinc-800/50">
                  Install from ollama.com, then run <code className="rounded bg-zinc-200/70 px-1 font-mono dark:bg-zinc-700">ollama pull {p.model || 'llama3.2'}</code>. FormPilot
                  rewrites the request Origin automatically, so you don't need to set OLLAMA_ORIGINS.
                </div>
              )}
            </>
          )}
          <div className="flex items-center gap-3 border-t border-zinc-100 px-5 py-3 dark:border-zinc-800/80">
            <Button onClick={runTest} loading={test.state === 'running'} disabled={!ready}>
              <Gauge className="size-3.5" /> Test connection
            </Button>
            {test.state === 'ok' && (
              <span className="flex items-center gap-1.5 text-[13px] text-emerald-600">
                <CheckCircle2 className="size-4" /> Connected · {test.ms}ms · <span className="font-mono">{test.msg}</span>
              </span>
            )}
            {test.state === 'fail' && (
              <span className="flex min-w-0 items-start gap-1.5 text-[13px] text-red-600">
                <XCircle className="mt-0.5 size-4 shrink-0" /> <span className="break-words">{test.msg}</span>
              </span>
            )}
            {onRemove && (
              <Button variant="ghost" size="icon-sm" className="ml-auto text-zinc-400 hover:text-red-600" onClick={onRemove} title="Remove provider">
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

const BUILTIN = new Set(['gemini', 'chrome-ai', 'openrouter', 'groq', 'ollama']);

export function Providers({ settings, update }: PageProps) {
  const [adding, setAdding] = useState(false);
  const providers = settings.providers;

  const move = (i: number, dir: -1 | 1) =>
    update((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.providers.length) return;
      [d.providers[i], d.providers[j]] = [d.providers[j], d.providers[i]];
    });

  return (
    <>
      <PageHeader
        title="AI Providers"
        description="Providers are tried top to bottom. If one fails (rate limit, outage, bad key) FormPilot moves on to the next automatically."
        actions={
          <Button variant="primary" onClick={() => setAdding((a) => !a)}>
            <Plus className="size-4" /> Add provider
          </Button>
        }
      />

      {adding && (
        <Card className="animate-fade-up mb-5 p-4">
          <div className="mb-3 text-sm font-medium">Add a provider</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {PROVIDER_PRESETS.map((pr) => (
              <button
                key={pr.presetId}
                className="rounded-xl border border-zinc-200 p-3 text-left transition hover:border-brand/50 hover:bg-brand/5 dark:border-zinc-800"
                onClick={() => {
                  update((d) => void d.providers.push(providerFromPreset(pr.presetId, { id: BUILTIN.has(pr.presetId) && !d.providers.some((x) => x.id === pr.presetId) ? pr.presetId : uid(pr.presetId + '-') })));
                  setAdding(false);
                  toast.success(`${pr.label} added`);
                }}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  {pr.label}
                  <Badge tone={pr.free === 'local' ? 'green' : pr.free === 'free' ? 'blue' : 'neutral'}>{pr.free}</Badge>
                </div>
                <div className="mt-1 text-xs text-zinc-500">{pr.blurb}</div>
              </button>
            ))}
          </div>
        </Card>
      )}

      <Card className="mb-5">
        <Row label="Automatic fallback" description="If the first provider fails, try the next one. Turn off to always use only the top provider.">
          <Switch checked={settings.generation.fallback} onCheckedChange={(v) => update((d) => void (d.generation.fallback = v))} />
        </Row>
        <Row label="Local-only mode" description="Only use on-device providers (Chrome AI, Ollama, LM Studio). Nothing leaves your computer.">
          <Switch checked={settings.privacy.localOnly} onCheckedChange={(v) => update((d) => void (d.privacy.localOnly = v))} />
        </Row>
      </Card>

      <div className="space-y-3">
        {providers.map((p, i) => (
          <ProviderCard
            key={p.id}
            p={p}
            index={i}
            total={providers.length}
            onMove={(dir) => move(i, dir)}
            onChange={(fn) => update((d) => fn(d.providers[i]))}
            onRemove={providers.length > 1 ? () => update((d) => void d.providers.splice(i, 1)) : undefined}
          />
        ))}
      </div>

      {!providers.some(providerConfigured) && (
        <Card className="mt-5">
          <CardHeader
            icon={<Cpu className="size-4" />}
            title="Quickest free setup"
            description="Open Google AI Studio, click “Create API key”, and paste it into the Gemini card above. It's free and takes about 30 seconds."
          />
        </Card>
      )}
    </>
  );
}
