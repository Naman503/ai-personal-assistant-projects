import { useState } from 'react';
import { MousePointerClick, Globe, TextCursorInput, Plus, X, Briefcase, Bot } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Input, PageHeader, Row, Segmented, Slider, Switch, Textarea } from '@/components/ui';
import { rpc } from '@/lib/messages';
import type { PageProps } from '../App';

function SiteList({ items, onChange, placeholder }: { items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [v, setV] = useState('');
  const add = () => {
    const host = v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host && !items.includes(host)) onChange([...items, host]);
    setV('');
  };
  return (
    <div className="w-full">
      <div className="flex gap-2">
        <Input placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
        <Button onClick={add}>
          <Plus className="size-3.5" /> Add
        </Button>
      </div>
      {items.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {items.map((h) => (
            <span key={h} className="inline-flex items-center gap-1 rounded-md bg-zinc-100 py-1 pr-1 pl-2 font-mono text-xs dark:bg-zinc-800">
              {h}
              <button className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700" onClick={() => onChange(items.filter((x) => x !== h))}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Behavior({ settings, update }: PageProps) {
  const b = settings.behavior;
  const set = <K extends keyof typeof b>(k: K, v: (typeof b)[K]) => update((d) => void (d.behavior[k] = v));

  return (
    <>
      <PageHeader title="Behavior" description="When and where the suggestion dropdown appears, and how text is inserted." />

      <Card className="mb-5">
        <CardHeader icon={<MousePointerClick className="size-4" />} title="Triggering" />
        <Row label="Enable FormPilot" description="Master switch for every website.">
          <Switch checked={b.enabled} onCheckedChange={(v) => set('enabled', v)} />
        </Row>
        <Row
          label="Open suggestions"
          description={
            b.trigger === 'focus'
              ? 'The dropdown opens when you click into a field, like a password manager.'
              : b.trigger === 'icon'
                ? 'A small ✦ icon appears in the field. Click it, or press Alt+J.'
                : 'Only opens with the keyboard shortcut (Alt+J) or the right-click menu.'
          }
        >
          <Segmented
            value={b.trigger}
            onChange={(v) => set('trigger', v)}
            options={[
              { value: 'focus', label: 'On focus' },
              { value: 'icon', label: 'Icon click' },
              { value: 'shortcut', label: 'Shortcut only' },
            ]}
          />
        </Row>
        <Row label="Generate AI suggestions automatically" description="Off: show memory/history matches first and generate only when you ask. Saves quota.">
          <Switch checked={b.autoGenerate} onCheckedChange={(v) => set('autoGenerate', v)} />
        </Row>
        {b.autoGenerate && (
          <Row label="Generation delay" description="Wait this long after focus before calling the AI. Tabbing quickly through fields costs nothing.">
            <Slider className="w-64" value={b.generateDelayMs} min={0} max={2000} step={50} onChange={(v) => set('generateDelayMs', v)} format={(v) => `${v}ms`} />
          </Row>
        )}
        <Row label="Show field icon" description="The ✦ button inside focused fields.">
          <Switch checked={b.showFieldIcon} onCheckedChange={(v) => set('showFieldIcon', v)} />
        </Row>
        <Row label="Auto-open in rich editors" description="Gmail, LinkedIn, Notion-style editors. Off by default because they're often chat or compose boxes.">
          <Switch checked={b.autoOpenOnContentEditable} onCheckedChange={(v) => set('autoOpenOnContentEditable', v)} />
        </Row>
        <Row label="Skip search boxes" description="Don't pop up on search, filter and query fields.">
          <Switch checked={b.skipSearchFields} onCheckedChange={(v) => set('skipSearchFields', v)} />
        </Row>
        <Row label="Minimum field width" description="Ignore tiny inputs (quantity boxes, OTP digits…).">
          <Slider className="w-64" value={b.minFieldWidth} min={0} max={300} step={10} onChange={(v) => set('minFieldWidth', v)} format={(v) => `${v}px`} />
        </Row>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<TextCursorInput className="size-4" />} title="Fields & insertion" />
        <Row label="Field types" description="Where FormPilot offers suggestions. Dropdowns and radios are handled by “Fill whole form”.">
          <div className="flex flex-wrap justify-end gap-3 text-[13px]">
            {(['input', 'textarea', 'contenteditable', 'select'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2">
                <Switch checked={b.fieldTypes[k]} onCheckedChange={(v) => update((d) => void (d.behavior.fieldTypes[k] = v))} />
                {k === 'contenteditable' ? 'Rich text' : k === 'input' ? 'Inputs' : k === 'textarea' ? 'Text areas' : 'Dropdowns'}
              </label>
            ))}
          </div>
        </Row>
        <Row label="Insert mode" description="Replace the field's content, or insert at the cursor.">
          <Segmented
            value={b.insertMode}
            onChange={(v) => set('insertMode', v)}
            options={[
              { value: 'replace', label: 'Replace' },
              { value: 'cursor', label: 'At cursor' },
            ]}
          />
        </Row>
        <Row label="Highlight filled fields" description="A brief outline flash so you can see what changed.">
          <Switch checked={b.highlightOnFill} onCheckedChange={(v) => set('highlightOnFill', v)} />
        </Row>
        <Row label="Never touched" description="Passwords, card numbers, CVV, OTP / 2FA codes, CAPTCHAs, PINs, government IDs and bank accounts are always skipped.">
          <Badge tone="green">Always on</Badge>
        </Row>
      </Card>

      <Card>
        <CardHeader icon={<Globe className="size-4" />} title="Websites" />
        <Row label="Run on" description={b.siteMode === 'all' ? 'Every website except the blocklist.' : 'Only websites on the allowlist.'}>
          <Segmented
            value={b.siteMode}
            onChange={(v) => set('siteMode', v)}
            options={[
              { value: 'all', label: 'All sites' },
              { value: 'allowlist', label: 'Allowlist only' },
            ]}
          />
        </Row>
        <Row
          label="Chat questionnaire sites"
          description="Job portals whose screening questions come as a chat in a popup (e.g. Naukri). On these sites FormPilot opens suggestions the moment the chat box is focused, re-reads the page to find the bot's latest question, and refreshes after every reply. No click needed, so popups that close on outside clicks keep working."
          stacked
        >
          <SiteList items={b.chatSites} onChange={(v) => set('chatSites', v)} placeholder="naukri.com" />
        </Row>
        {b.siteMode === 'allowlist' ? (
          <Row label="Allowed sites" description="Subdomains are included. Use *.example.com for all subdomains." stacked>
            <SiteList items={b.allowedSites} onChange={(v) => set('allowedSites', v)} placeholder="jobs.lever.co" />
          </Row>
        ) : (
          <Row label="Blocked sites" description="FormPilot stays completely quiet on these. You can also pause a site from the toolbar popup." stacked>
            <SiteList items={b.blockedSites} onChange={(v) => set('blockedSites', v)} placeholder="mail.google.com" />
          </Row>
        )}
      </Card>

      <JobTracker settings={settings} update={update} />
      <AutopilotCard settings={settings} update={update} />
    </>
  );
}

function JobTracker({ settings, update }: Pick<PageProps, 'settings' | 'update'>) {
  const t = settings.tracker;
  const set = <K extends keyof typeof t>(k: K, v: (typeof t)[K]) => update((d) => void (d.tracker[k] = v));
  const [url, setUrl] = useState(t.url);
  const [status, setStatus] = useState<{ tone: 'green' | 'red' | 'neutral'; text: string } | null>(null);
  const test = async () => {
    setStatus({ tone: 'neutral', text: 'Checking…' });
    try {
      // Brave/Chrome may limit FormPilot's site access ("On specific sites"): ask for the tracker's address.
      // Must run straight from the click, before any other await.
      const origin = new URL(url.trim().replace(/\/+$/, '')).origin + '/*';
      const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
      if (!granted) {
        setStatus({ tone: 'red', text: `Allow FormPilot to access ${new URL(url.trim()).host} to use the tracker.` });
        return;
      }
      const r = await rpc<{ applications: number; people: number }>({ type: 'tracker-test', url });
      setStatus({ tone: 'green', text: `Connected: ${r.applications} applications, ${r.people} people` });
    } catch (e) {
      setStatus({ tone: 'red', text: (e as Error).message });
    }
  };
  return (
    <Card className="mt-5">
      <CardHeader icon={<Briefcase className="size-4" />} title="Job tracker" />
      <Row label="Record applications in a job tracker" description="When a site confirms your application was sent, FormPilot adds it to your tracker as Applied, with the job details. Off by default.">
        <Switch checked={t.enabled} onCheckedChange={(v) => set('enabled', v)} />
      </Row>
      <Row label="Tracker address" description="Your Job Search Desk (or any server with the same API). Requests go only to this address." stacked>
        <div className="flex w-full gap-2">
          <Input placeholder="https://desk.your-tailnet.ts.net:8444" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => set('url', url.trim())} />
          <Button onClick={() => (set('url', url.trim()), void test())}>Test connection</Button>
        </div>
        {status && (
          <div className="mt-2">
            <Badge tone={status.tone}>{status.text}</Badge>
          </div>
        )}
      </Row>
      <Row label="Record automatically" description='Watches for "Your application was sent", "Thank you for applying" and thank-you pages after you press Submit. Off: use "I applied" in the toolbar popup instead.'>
        <Switch checked={t.autoRecord} disabled={!t.enabled} onCheckedChange={(v) => set('autoRecord', v)} />
      </Row>
      <Row label="Include my answers" description="Saves the questions and answers from the form (for example the CTC and notice period you gave) with the application. Passwords and sensitive fields are never included.">
        <Switch checked={t.includeAnswers} disabled={!t.enabled} onCheckedChange={(v) => set('includeAnswers', v)} />
      </Row>
      <Row label="Walk the form to Submit" description='After "Fill this form" on a multi-step application (LinkedIn Easy Apply and similar), FormPilot presses Next or Review for you, fills each step, and stops at the Submit button with it highlighted. It never presses Submit, and it stops when a step needs you (an empty required field, a checkbox, an error).'>
        <Switch checked={t.walkToSubmit} onCheckedChange={(v) => set('walkToSubmit', v)} />
      </Row>
      <Row label="Apply queue: daily limit" description="On a LinkedIn job search, “Apply to this list” opens each Easy Apply job, fills it to the Submit button and waits for you to press Submit, then moves to the next. It stops after this many sent per day. Above about 50 a day LinkedIn is more likely to check the account.">
        <Input type="number" min={1} max={200} className="w-24" value={String(t.queueDailyCap)} onChange={(e) => set('queueDailyCap', Math.max(1, Math.min(200, Number(e.target.value) || 30)))} />
      </Row>
      <Row label="Apply queue: pause between jobs (seconds)" description="Randomised by ±50% so the clicks don't come at a fixed rhythm.">
        <Input type="number" min={0} max={120} className="w-24" value={String(t.queueDelaySec)} onChange={(e) => set('queueDelaySec', Math.max(0, Math.min(120, Number(e.target.value) || 0)))} />
      </Row>
      <Row label="Apply queue: submit for me" description="Off: the queue stops at Submit and waits for you. On: when a form is filled to the end with nothing left for you, it counts down 5 to 9 seconds and presses Submit itself (Skip or Stop cancels). Applications go out with the AI's answers unchecked, so read a few in the tracker first. Steps that need you still stop and wait.">
        <Switch checked={t.queueAutoSubmit} onCheckedChange={(v) => set('queueAutoSubmit', v)} />
      </Row>
      <Row label="Apply queue: skip job titles containing" description="Comma separated, e.g. Engineering Manager, Director, iOS, .NET" stacked>
        <Input placeholder="Engineering Manager, Director, iOS" value={t.queueSkipTitles} onChange={(e) => set('queueSkipTitles', e.target.value)} />
      </Row>
    </Card>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function AutopilotCard({ settings, update }: Pick<PageProps, 'settings' | 'update'>) {
  const a = settings.autopilot;
  const set = <K extends keyof typeof a>(k: K, v: (typeof a)[K]) => update((d) => void (d.autopilot[k] = v));
  const num = (k: 'dailyCap' | 'perTitleCap' | 'batchMin' | 'batchMax' | 'gapMinMin' | 'gapMaxMin', min: number, max: number) => (
    <Input type="number" min={min} max={max} className="w-20" value={String(a[k])} onChange={(e) => set(k, Math.max(min, Math.min(max, Number(e.target.value) || min)))} />
  );
  const [titles, setTitles] = useState(a.titles);
  return (
    <Card className="mt-5">
      <CardHeader icon={<Bot className="size-4" />} title="Autopilot (LinkedIn)" />
      <Row label="What it does" description="Start it from the toolbar popup. It opens its own Brave window without taking focus, and every 20–40 minutes in your active hours it searches LinkedIn for the next job title and applies to a small batch of Easy Apply jobs. Jobs that need you are skipped, never waited on. It stops on any security check, limit or sign-out and tells you. Keep its window open (it can sit behind other windows); closing it stops the autopilot." stacked>
        <span />
      </Row>
      <Row label="Dry run" description="On: fills each form to Submit and saves the job to your tracker as “would apply” with every answer in Options → Logs, but sends nothing. Turn it off only after checking a few days of dry runs.">
        <Switch checked={a.dryRun} onCheckedChange={(v) => set('dryRun', v)} />
      </Row>
      <Row label="Job titles" description="One search per title, taken in turn. Comma separated or one per line." stacked>
        <Textarea rows={3} value={titles} onChange={(e) => setTitles(e.target.value)} onBlur={() => set('titles', titles)} />
      </Row>
      <Row label="Where" description="All of India includes on-site, hybrid and remote jobs in India.">
        <Segmented value={a.location} onChange={(v) => set('location', v as typeof a.location)} options={[{ value: 'india', label: 'All India + remote' }, { value: 'india-remote', label: 'Remote only' }]} />
      </Row>
      <Row label="Posted within" description="Newer jobs get fewer applicants.">
        <Segmented value={String(a.postedDays)} onChange={(v) => set('postedDays', Number(v))} options={[{ value: '1', label: '24 hours' }, { value: '7', label: 'Week' }, { value: '30', label: 'Month' }]} />
      </Row>
      <Row label="Daily limit" description="Applications (or dry-run “would apply”) per day, and per job title.">
        <div className="flex items-center gap-2 text-sm">{num('dailyCap', 1, 100)} total · {num('perTitleCap', 1, 100)} per title</div>
      </Row>
      <Row label="Batch size and gap" description="Jobs per batch, and minutes between batches (random in the range).">
        <div className="flex items-center gap-2 text-sm">{num('batchMin', 1, 20)}–{num('batchMax', 1, 20)} jobs · every {num('gapMinMin', 1, 240)}–{num('gapMaxMin', 1, 240)} min</div>
      </Row>
      <Row label="Active hours (India time)" description="It only applies inside these hours, on the ticked days.">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Input className="w-20" value={a.startTime} onChange={(e) => set('startTime', e.target.value)} />–<Input className="w-20" value={a.endTime} onChange={(e) => set('endTime', e.target.value)} />
          {DAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
              <input type="checkbox" checked={a.days.includes(i)} onChange={(e) => set('days', e.target.checked ? [...a.days, i].sort() : a.days.filter((x) => x !== i))} />
              {d}
            </label>
          ))}
        </div>
      </Row>
    </Card>
  );
}
