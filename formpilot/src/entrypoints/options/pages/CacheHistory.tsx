import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Zap, History, Trash2, GraduationCap } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Empty, PageHeader, Row, Segmented, Slider, Switch } from '@/components/ui';
import { db, type HistoryEntry } from '@/lib/memory/db';
import { rpc, type Stats } from '@/lib/messages';
import type { PageProps } from '../App';

export function CacheHistory({ settings, update }: PageProps) {
  const c = settings.cache;
  const set = <K extends keyof typeof c>(k: K, v: (typeof c)[K]) => update((d) => void (d.cache[k] = v));
  const [rows, setRows] = useState<HistoryEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const reload = async () => {
    setRows(await db().history.orderBy('lastUsed').reverse().limit(200).toArray());
    setStats(await rpc<Stats>({ type: 'stats' }).catch(() => null));
  };
  useEffect(() => {
    void reload();
  }, []);

  const clear = async (what: 'responses' | 'history' | 'all') => {
    if (!confirm(what === 'responses' ? 'Clear all cached AI responses?' : 'Forget all learned answers?')) return;
    await rpc({ type: 'clear-cache', what });
    toast.success('Cleared');
    void reload();
  };

  return (
    <>
      <PageHeader title="Speed & History" description="Three layers make repeated questions instant: key facts, answers you used before, and a cache of AI responses." />

      <Card className="mb-5">
        <CardHeader
          icon={<GraduationCap className="size-4" />}
          title="Learn from your corrections"
          description="When FormPilot suggests something wrong and you type the right answer yourself, it can remember it, so next time that question is answered instantly and correctly."
        />
        <Row
          label="When you type your own answer"
          description={
            c.learn === 'ask'
              ? 'A small prompt asks “Remember this answer?” when you leave the field or submit.'
              : c.learn === 'auto'
                ? 'Your answer is saved silently and a short confirmation is shown.'
                : 'Nothing is saved automatically. You can still use “Save my answer” in the dropdown or the right-click menu.'
          }
        >
          <Segmented
            value={c.learn}
            onChange={(v) => set('learn', v)}
            options={[
              { value: 'ask', label: 'Ask me' },
              { value: 'auto', label: 'Save automatically' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </Row>
        <Row
          label="Save corrections as"
          description={
            c.learnSaveAs === 'smart'
              ? 'Exact question → your answer (instant, no AI). Short answers also become a key fact; long answers go into the “Saved answers” note in Memory, so the AI uses them for similar questions too.'
              : 'Only for the exact same question (instant, no AI). Memory and facts are not changed.'
          }
        >
          <Segmented
            value={c.learnSaveAs}
            onChange={(v) => set('learnSaveAs', v)}
            options={[
              { value: 'smart', label: 'Answer + memory' },
              { value: 'history', label: 'Answer only' },
            ]}
          />
        </Row>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<Zap className="size-4" />} title="Instant answers" description={stats ? `${stats.counters.instantHits} instant and ${stats.counters.cacheHits} cached answers this session.` : undefined} />
        <Row label="Facts" description="Match fields like Email or Phone to your key facts with no network call.">
          <Switch checked={c.instantFacts} onCheckedChange={(v) => set('instantFacts', v)} />
        </Row>
        <Row label="Learn from answers you insert" description="When you insert a suggestion, remember it for similar questions on any site.">
          <Switch checked={c.history} onCheckedChange={(v) => set('history', v)} />
        </Row>
        {c.history && (
          <Row label="History match strictness" description="Lower values match more loosely worded questions.">
            <Slider className="w-64" value={c.historyThreshold} min={0.3} max={1} step={0.05} onChange={(v) => set('historyThreshold', Math.round(v * 100) / 100)} format={(v) => v.toFixed(2)} />
          </Row>
        )}
        <Row label="Cache AI responses" description="Identical question + context + model → reuse the previous answer instantly.">
          <Switch checked={c.responseCache} onCheckedChange={(v) => set('responseCache', v)} />
        </Row>
        {c.responseCache && (
          <Row label="Cache lifetime">
            <Slider className="w-64" value={c.responseCacheTtlHours} min={1} max={24 * 30} step={1} onChange={(v) => set('responseCacheTtlHours', v)} format={(v) => (v < 48 ? `${v}h` : `${Math.round(v / 24)}d`)} />
          </Row>
        )}
        <Row label="Stored data" description={stats ? `${stats.cache} cached responses · ${stats.history} learned answers` : ''}>
          <div className="flex gap-2">
            <Button onClick={() => clear('responses')}>Clear cache</Button>
            <Button variant="ghost" className="text-red-600" onClick={() => clear('history')}>
              Forget history
            </Button>
          </div>
        </Row>
      </Card>

      <Card>
        <CardHeader icon={<History className="size-4" />} title="Learned answers" description="Most recent first. Delete any you don't want suggested again." />
        {rows.length === 0 ? (
          <Empty icon={<History className="size-5" />} title="Nothing learned yet" description="Answers you insert will show up here." />
        ) : (
          <div className="max-h-[520px] overflow-y-auto">
            {rows.map((r) => (
              <div key={r.id} className="group flex items-start gap-3 px-5 py-3 not-last:border-b not-last:border-zinc-100 dark:not-last:border-zinc-800/60">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-zinc-500">
                    {r.question} · {r.host} · used {r.count}×
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-sm">
                    {r.verified && (
                      <Badge tone="green" className="mr-1.5">
                        Saved answer
                      </Badge>
                    )}
                    {r.answer}
                  </div>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="opacity-0 group-hover:opacity-100 hover:text-red-600"
                  onClick={async () => {
                    await db().history.delete(r.id);
                    await rpc({ type: 'memory-changed' });
                    void reload();
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
