import { useEffect, useState } from 'react';
import { Bot, Activity, Clock, Filter, Gauge, History, Play, Square, FastForward } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Input, PageHeader, Row, Segmented, Switch, Textarea } from '@/components/ui';
import { describe, time, useAutopilot } from '@/hooks/useAutopilot';
import { relevantWords } from '@/lib/queue';
import { titlesOf } from '@/lib/autopilot';
import type { PageProps } from '../App';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function Autopilot({ settings, update }: PageProps) {
  const a = settings.autopilot;
  const set = <K extends keyof typeof a>(k: K, v: (typeof a)[K]) => update((d) => void (d.autopilot[k] = v));
  const { st, call } = useAutopilot();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const d = describe(st);
  const [titles, setTitles] = useState(a.titles);
  const [skip, setSkip] = useState(a.skipWords);
  const [must, setMust] = useState(a.mustWords);
  const num = (k: 'dailyCap' | 'perTitleCap' | 'batchMin' | 'batchMax' | 'gapMinMin' | 'gapMaxMin' | 'pauseMinSec' | 'pauseMaxSec', min: number, max: number) => (
    <Input type="number" min={min} max={max} className="w-20" value={String(a[k])} onChange={(e) => set(k, Math.max(min, Math.min(max, Number(e.target.value) || min)))} />
  );
  const day = st?.day;
  const words = must.trim() ? relevantWords(must.split(/[,\n]+/)) : relevantWords(titlesOf({ titles }));

  return (
    <>
      <PageHeader
        title="Autopilot"
        description="Applies to LinkedIn Easy Apply jobs on its own, in its own Brave window, in small batches with breaks, inside your active hours."
        actions={
          st?.running ? (
            <div className="flex gap-2">
              <Button onClick={() => void call('run-now')} disabled={!d.canSkip} title="Skip the current break or pause">
                <FastForward className="size-4" /> Skip break
              </Button>
              <Button variant="danger" onClick={() => void call('stop')}>
                <Square className="size-4" /> Stop
              </Button>
            </div>
          ) : (
            <Button variant="primary" onClick={() => void call('start')}>
              <Play className="size-4" /> Start
            </Button>
          )
        }
      />

      <Card className="mb-5">
        <CardHeader icon={<Activity className="size-4" />} title="Now" />
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={d.tone}>{st?.running ? 'On' : 'Off'}</Badge>
            {a.dryRun ? <Badge tone="amber">Dry run · nothing is sent</Badge> : <Badge tone="red">Live · applications are sent</Badge>}
            <span className="text-sm font-semibold">{d.title}</span>
          </div>
          <div className="text-sm text-zinc-600 dark:text-zinc-400">{d.detail}</div>
          {day ? (
            <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              {[
                ['Sent', day.sent],
                ['Would apply (dry run)', day.dry],
                ['Skipped', day.skipped],
                ['Today', `${day.sent + day.dry} / ${a.dailyCap}`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl border border-zinc-200 p-2 dark:border-zinc-800">
                  <div className="text-lg font-semibold">{v}</div>
                  <div className="text-[11px] text-zinc-500">{k}</div>
                </div>
              ))}
            </div>
          ) : null}
          {day && Object.keys(day.perTitle).length ? (
            <div className="text-xs text-zinc-500">
              Per title: {Object.entries(day.perTitle).map(([t, n]) => `${t} ${n}/${a.perTitleCap}`).join(' · ')}
              {day.exhausted.length ? ` · nothing left today: ${day.exhausted.join(', ')}` : ''}
            </div>
          ) : null}
        </div>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<History className="size-4" />} title="What it did" />
        <div className="max-h-64 overflow-auto p-4 text-xs">
          {(st?.history ?? []).slice().reverse().map((h, i) => (
            <div key={i} className="flex gap-2 py-0.5">
              <span className="shrink-0 tabular-nums text-zinc-400">{time(h.t)}</span>
              <span>{h.msg}</span>
            </div>
          ))}
          {!st?.history?.length ? <div className="text-zinc-500">Nothing yet. Each job's answers are in Logs &amp; Diagnostics.</div> : null}
        </div>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<Bot className="size-4" />} title="Mode" />
        <Row label="Dry run" description="On: fills each form to Submit, saves the job to your tracker as “would apply” and logs every answer, but sends nothing. Off: presses Submit when nothing on the form needs you.">
          <Switch checked={a.dryRun} onCheckedChange={(v) => set('dryRun', v)} />
        </Row>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<Filter className="size-4" />} title="Which jobs" />
        <Row label="Job titles" description="One LinkedIn search per title, taken in turn. Comma separated or one per line." stacked>
          <Textarea rows={3} value={titles} onChange={(e) => setTitles(e.target.value)} onBlur={() => set('titles', titles)} />
        </Row>
        <Row label="Where" description="All of India includes on-site, hybrid and remote jobs in India.">
          <Segmented value={a.location} onChange={(v) => set('location', v as typeof a.location)} options={[{ value: 'india', label: 'All India + remote' }, { value: 'india-remote', label: 'Remote only' }]} />
        </Row>
        <Row label="Posted within" description="Newer jobs get fewer applicants.">
          <Segmented value={String(a.postedDays)} onChange={(v) => set('postedDays', Number(v))} options={[{ value: '1', label: '24 hours' }, { value: '7', label: 'Week' }, { value: '30', label: 'Month' }]} />
        </Row>
        <Row label="Job title must contain" description={`Only jobs whose title has one of these words. Empty: taken from your titles (now: ${words.join(', ') || 'any'}).`} stacked>
          <Input placeholder="react, native, mobile, full, stack, software" value={must} onChange={(e) => setMust(e.target.value)} onBlur={() => set('mustWords', must)} />
        </Row>
        <Row label="Skip titles containing" description="Comma separated, e.g. Intern, Director, Flutter, iOS." stacked>
          <Input value={skip} onChange={(e) => setSkip(e.target.value)} onBlur={() => set('skipWords', skip)} />
        </Row>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<Gauge className="size-4" />} title="How much and how fast" />
        <Row label="Daily limit" description="Applications (or dry-run “would apply”) per day, in total and per job title.">
          <div className="flex items-center gap-2 text-sm">
            {num('dailyCap', 1, 100)} total · {num('perTitleCap', 1, 100)} per title
          </div>
        </Row>
        <Row label="Batch size" description="Jobs per batch (random in the range).">
          <div className="flex items-center gap-2 text-sm">
            {num('batchMin', 1, 20)}–{num('batchMax', 1, 20)} jobs
          </div>
        </Row>
        <Row label="Break between batches" description="Minutes (random in the range). “Skip break” starts the next batch now.">
          <div className="flex items-center gap-2 text-sm">
            {num('gapMinMin', 1, 240)}–{num('gapMaxMin', 1, 240)} min
          </div>
        </Row>
        <Row label="Pause between jobs" description="Seconds after each job inside a batch (random). “Skip break” ends it early.">
          <div className="flex items-center gap-2 text-sm">
            {num('pauseMinSec', 0, 600)}–{num('pauseMaxSec', 0, 600)} s
          </div>
        </Row>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<Clock className="size-4" />} title="When" />
        <Row label="Active hours (India time)" description="It only applies inside these hours, on the ticked days. Outside them it waits; “Skip break” runs one batch anyway.">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Input className="w-20" value={a.startTime} onChange={(e) => set('startTime', e.target.value)} />–<Input className="w-20" value={a.endTime} onChange={(e) => set('endTime', e.target.value)} />
            {DAYS.map((dn, i) => (
              <label key={dn} className="flex items-center gap-1">
                <input type="checkbox" checked={a.days.includes(i)} onChange={(e) => set('days', e.target.checked ? [...a.days, i].sort() : a.days.filter((x) => x !== i))} />
                {dn}
              </label>
            ))}
          </div>
        </Row>
      </Card>
    </>
  );
}
