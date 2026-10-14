import { useState } from 'react';
import { MousePointerClick, Globe, TextCursorInput, Plus, X } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Input, PageHeader, Row, Segmented, Slider, Switch } from '@/components/ui';
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
    </>
  );
}
