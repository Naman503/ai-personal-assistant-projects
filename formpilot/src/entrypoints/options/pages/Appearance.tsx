import { Palette, Sparkles, UserRound, CornerDownLeft } from 'lucide-react';
import { Card, CardHeader, PageHeader, Row, Segmented, Slider, Switch } from '@/components/ui';
import { cn } from '@/components/ui/cn';
import type { PageProps } from '../App';

const ACCENTS = [
  ['violet', '#7c3aed'],
  ['blue', '#2563eb'],
  ['emerald', '#059669'],
  ['orange', '#ea580c'],
  ['rose', '#e11d48'],
  ['slate', '#475569'],
] as const;

/** Static preview of the in-page dropdown. */
function Preview({ compact }: { compact: boolean }) {
  return (
    <div className="pointer-events-none mx-auto w-full max-w-md select-none">
      <div className="mb-2 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-400 ring-3 ring-brand/15 dark:border-zinc-700 dark:bg-zinc-900">Why do you want to join us?</div>
      <div className="overflow-hidden rounded-xl bg-white shadow-2xl ring-1 shadow-zinc-900/15 ring-zinc-900/10 dark:bg-zinc-900 dark:ring-white/10">
        <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
          <span className="grid size-5 place-items-center rounded-md bg-gradient-to-br from-brand to-fuchsia-500 text-white">
            <Sparkles className="size-3" />
          </span>
          <div className="text-[11px] leading-tight">
            <div className="font-semibold text-zinc-500">FormPilot</div>
            <div className="font-medium">Why do you want to join us?</div>
          </div>
        </div>
        <div className="p-1.5">
          {[
            ['ai', 'Concise', 'I want to build products that help millions of small businesses, and your focus on…'],
            ['ai', 'Detailed', 'Over the past six years I have shipped React apps used by…'],
            ['fact', 'Memory', 'Jane Doe · jane@doe.dev'],
          ].map(([src, title, text], i) => (
            <div key={i} className={cn('flex gap-2.5 rounded-lg px-2.5', compact ? 'py-1.5' : 'py-2', i === 0 && 'bg-brand/10')}>
              <span className={cn('mt-0.5 grid size-6 shrink-0 place-items-center rounded-md', src === 'ai' ? 'bg-brand/10 text-brand' : 'bg-cyan-500/10 text-cyan-600')}>
                {src === 'ai' ? <Sparkles className="size-3.5" /> : <UserRound className="size-3.5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-zinc-500">{title}</div>
                <div className={cn('text-[13px]', compact ? 'line-clamp-1' : 'line-clamp-2')}>{text}</div>
              </div>
              {i === 0 && <CornerDownLeft className="mt-2 size-3 text-zinc-400" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Appearance({ settings, update }: PageProps) {
  const a = settings.appearance;
  const set = <K extends keyof typeof a>(k: K, v: (typeof a)[K]) => update((d) => void (d.appearance[k] = v));
  return (
    <>
      <PageHeader title="Appearance" description="Applies to this settings page and to the suggestion dropdown on websites." />
      <Card className="mb-5 bg-[radial-gradient(circle_at_30%_0%,color-mix(in_srgb,var(--brand)_10%,transparent),transparent_60%)] p-8">
        <Preview compact={a.density === 'compact'} />
      </Card>
      <Card>
        <CardHeader icon={<Palette className="size-4" />} title="Style" />
        <Row label="Theme">
          <Segmented
            value={a.theme}
            onChange={(v) => set('theme', v)}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
        <Row label="Accent color">
          <div className="flex gap-2">
            {ACCENTS.map(([name, hex]) => (
              <button
                key={name}
                title={name}
                onClick={() => set('accent', name)}
                className={cn('size-7 rounded-full ring-offset-2 ring-offset-white transition dark:ring-offset-zinc-900', a.accent === name ? 'ring-2 ring-zinc-900 dark:ring-white' : 'hover:scale-110')}
                style={{ background: hex }}
              />
            ))}
          </div>
        </Row>
        <Row label="Density">
          <Segmented
            value={a.density}
            onChange={(v) => set('density', v)}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </Row>
        <Row label="Dropdown max width" description="The dropdown matches the field's width, up to this limit.">
          <Slider className="w-64" value={a.dropdownMaxWidth} min={300} max={720} step={20} onChange={(v) => set('dropdownMaxWidth', v)} format={(v) => `${v}px`} />
        </Row>
        <Row label="Reduce motion">
          <Switch checked={a.reduceMotion} onCheckedChange={(v) => set('reduceMotion', v)} />
        </Row>
      </Card>
    </>
  );
}
