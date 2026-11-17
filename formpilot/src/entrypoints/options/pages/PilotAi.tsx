import { useEffect, useState } from 'react';
import { BarChart3, Cpu } from 'lucide-react';
import { Button, Card, CardHeader, Input, Row, Segmented } from '@/components/ui';
import { cloudProviders, describePilotAi, PILOT_NAME, type Pilot } from '@/lib/llm/pilot-ai';
import { AI_STATS_KEY, loadAiStats, reportRows, resetAiStats, type AiStats } from '@/lib/ai-stats';
import type { PageProps } from '../App';

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
const sec = (x: number | null) => (x === null ? '–' : `${x < 10 ? x.toFixed(1) : Math.round(x)} s`);

/** Which AI this pilot uses (separate from AI Providers, which stays for your own form filling). */
export function PilotAiCard({ who, settings, update }: { who: Pilot } & Pick<PageProps, 'settings' | 'update'>) {
  const c = settings.pilotAi[who];
  const clouds = cloudProviders(settings);
  const [local, setLocal] = useState(c.localModel);
  const [installed, setInstalled] = useState<string[]>([]);
  const set = <K extends keyof typeof c>(k: K, v: (typeof c)[K]) => update((d) => void (d.pilotAi[who][k] = v));
  useEffect(() => {
    const base = settings.providers.find((p) => p.kind === 'ollama' && p.baseUrl)?.baseUrl || settings.sitePilot.baseUrl;
    void fetch(`${base.replace(/\/+$/, '')}/api/tags`)
      .then((r) => r.json())
      .then((j: { models?: { name: string }[] }) => setInstalled((j.models ?? []).map((m) => m.name)))
      .catch(() => setInstalled([]));
  }, [settings.providers, settings.sitePilot.baseUrl]);
  return (
    <Card className="mb-5">
      <CardHeader icon={<Cpu className="size-4" />} title={`${PILOT_NAME[who]}'s AI`} description={`Only for the ${PILOT_NAME[who]}. Your own form filling keeps using AI Providers. Now: ${describePilotAi(settings, who)}.`} />
      <Row label="Use" description="Cloud, then local: the cloud model answers, and the local model takes over when the cloud one is rate-limited, out of its daily quota or down. Local only never sends your answers or screenshots to a cloud service.">
        <Segmented
          value={c.mode}
          onChange={(v) => set('mode', v as typeof c.mode)}
          options={[
            { value: 'cloud-then-local', label: 'Cloud, then local' },
            { value: 'cloud', label: 'Cloud only' },
            { value: 'local', label: 'Local only' },
          ]}
        />
      </Row>
      <Row label="Cloud model" description={clouds.length ? 'From your AI Providers (its key and limits). Its extra models are tried before the local one.' : 'No cloud provider set up: add a Gemini key in AI Providers.'}>
        <select
          className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          value={c.cloud}
          disabled={!clouds.length || c.mode === 'local'}
          onChange={(e) => set('cloud', e.target.value)}
        >
          <option value="">{clouds.find((p) => p.kind === 'gemini') ? 'Gemini (default)' : 'First cloud provider'}</option>
          {clouds.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} · {p.model}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Local model" description={`Ollama model. Empty: ${settings.sitePilot.model}. Installed: ${installed.join(', ') || 'Ollama not reachable'}.`}>
        <Input className="w-48" placeholder={settings.sitePilot.model} value={local} disabled={c.mode === 'cloud'} onChange={(e) => setLocal(e.target.value)} onBlur={() => set('localModel', local.trim())} />
      </Row>
    </Card>
  );
}

/** How each model has done for this pilot. */
export function PilotAiReport({ who }: { who: Pilot }) {
  const [stats, setStats] = useState<AiStats | null>(null);
  useEffect(() => {
    void loadAiStats().then(setStats);
    const on = (ch: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && ch[AI_STATS_KEY]) setStats((ch[AI_STATS_KEY].newValue as AiStats | undefined) ?? null);
    };
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, []);
  const rows = stats ? reportRows(stats, who) : [];
  const best = rows.filter((r) => r.calls >= 5 && r.answerRate !== null).sort((a, b) => (b.completion ?? 0) - (a.completion ?? 0) || (b.answerRate ?? 0) - (a.answerRate ?? 0))[0];
  return (
    <Card className="mb-5">
      <CardHeader
        icon={<BarChart3 className="size-4" />}
        title="Which model does better"
        description={stats ? `Since ${new Date(stats.since).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}. Answered: share of questions the model gave an answer to. Completed: applications sent or ready, out of all it finished.` : ''}
        actions={
          <Button size="sm" variant="ghost" onClick={() => void resetAiStats()}>
            Reset
          </Button>
        }
      />
      <div className="overflow-x-auto p-4">
        {rows.length ? (
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Model</th>
                <th className="pr-3 font-medium">AI calls</th>
                <th className="pr-3 font-medium">Answered</th>
                <th className="pr-3 font-medium">Time per call</th>
                <th className="pr-3 font-medium">Failed</th>
                <th className="pr-3 font-medium">Took over</th>
                <th className="pr-3 font-medium">Sent</th>
                <th className="pr-3 font-medium">Ready</th>
                <th className="pr-3 font-medium">Left for you</th>
                <th className="pr-3 font-medium">Skipped</th>
                <th className="font-medium">Completed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1.5 pr-3 font-medium">
                    {r.model}
                    {best?.model === r.model && rows.length > 1 ? <span className="ml-1 text-emerald-600">best so far</span> : null}
                  </td>
                  <td className="pr-3 tabular-nums">{r.calls}</td>
                  <td className="pr-3 tabular-nums">{pct(r.answerRate)}</td>
                  <td className="pr-3 tabular-nums">{sec(r.avgSec)}</td>
                  <td className="pr-3 tabular-nums">{pct(r.failRate)}</td>
                  <td className="pr-3 tabular-nums" title="Calls the local model answered because the cloud one couldn't">{r.fallbacks || ''}</td>
                  <td className="pr-3 tabular-nums">{r.outcomes.sent ?? 0}</td>
                  <td className="pr-3 tabular-nums">{r.outcomes.ready ?? 0}</td>
                  <td className="pr-3 tabular-nums">{(r.outcomes['needs-you'] ?? 0) + (r.outcomes.unsure ?? 0)}</td>
                  <td className="pr-3 tabular-nums">{r.outcomes.skipped ?? 0}</td>
                  <td className="tabular-nums">{pct(r.completion)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-sm text-zinc-500">Nothing yet: the table fills in as the {PILOT_NAME[who]} works.</div>
        )}
        <div className="mt-2 text-[11px] text-zinc-500">
          Accuracy needs your eye: open an application's answers on the Site Pilot page, or Logs for the Autopilot. Answers you change on a form are learned either way.
        </div>
      </div>
    </Card>
  );
}
