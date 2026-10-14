import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Eye, Keyboard, LocateFixed, Move, PanelTop, Pin } from 'lucide-react';
import { Button, Card, CardHeader, Kbd, PageHeader, Row, Segmented, Slider, Switch } from '@/components/ui';
import { clearAllPositions, loadPositions, watchPositions } from '@/lib/panel-position';
import type { PageProps } from '../App';

export function PopupSettings({ settings, update }: PageProps) {
  const p = settings.panel;
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => update((d) => void (d.panel[k] = v));
  const [saved, setSaved] = useState<string[]>([]);

  useEffect(() => {
    void loadPositions().then((all) => setSaved(Object.keys(all)));
    return watchPositions((all) => setSaved(Object.keys(all)));
  }, []);

  return (
    <>
      <PageHeader
        title="Popup"
        description="Everything about the suggestion popup that appears under a field: where it opens, whether you can move it, when it stays on screen, and what it shows."
      />

      <Card className="mb-5">
        <CardHeader icon={<Move className="size-4" />} title="Position" description="Drag the popup by its header to move it. FormPilot remembers where you put it." />
        <Row label="Open" description="Where the popup appears next to the field, until you drag it somewhere. Auto opens below and flips above when there's no room.">
          <Segmented
            value={p.placement}
            onChange={(v) => set('placement', v)}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'below', label: 'Below' },
              { value: 'above', label: 'Above' },
              { value: 'right', label: 'Right' },
              { value: 'left', label: 'Left' },
            ]}
          />
        </Row>
        <Row label="Drag to move" description="Grab the popup's header (or the grip bar when the header is hidden) and drop it anywhere.">
          <Switch checked={p.draggable} onCheckedChange={(v) => set('draggable', v)} />
        </Row>
        {p.draggable && (
          <>
            <Row
              label="Remember the position"
              description={
                p.rememberPosition === 'per-site'
                  ? 'Each website keeps its own popup position (e.g. a chat drawer on one site, normal forms on another).'
                  : p.rememberPosition === 'everywhere'
                    ? 'One position used on every website.'
                    : 'A moved popup returns to the field after the page reloads.'
              }
            >
              <Segmented
                value={p.rememberPosition}
                onChange={(v) => set('rememberPosition', v)}
                options={[
                  { value: 'per-site', label: 'Per site' },
                  { value: 'everywhere', label: 'Everywhere' },
                  { value: 'off', label: 'Off' },
                ]}
              />
            </Row>
            <Row
              label="A moved popup"
              description={
                p.dragAnchor === 'screen'
                  ? 'Stays at that spot on the screen, like a docked panel, whichever field you are in.'
                  : 'Keeps the same distance from the field, so it scrolls along with it.'
              }
            >
              <Segmented
                value={p.dragAnchor}
                onChange={(v) => set('dragAnchor', v)}
                options={[
                  { value: 'screen', label: 'Stays on screen' },
                  { value: 'field', label: 'Follows the field' },
                ]}
              />
            </Row>
          </>
        )}
        <Row
          label="Saved positions"
          description={saved.length ? `Saved for: ${saved.map((k) => (k === '*' ? 'all sites' : k)).join(', ')}. You can also reset one from the popup's ⋯ menu.` : 'None yet. Drag the popup on any site to save one.'}
        >
          <Button
            disabled={!saved.length}
            onClick={async () => {
              await clearAllPositions();
              toast.success('All popup positions reset');
            }}
          >
            <LocateFixed className="size-3.5" /> Reset all positions
          </Button>
        </Row>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<Pin className="size-4" />} title="Staying on screen" description="Pin the popup with the 📌 button to keep it open while you click around or type." />
        <Row label="Pinned by default" description="Every popup starts pinned: it stays on screen until you close it, and follows whichever field you focus next.">
          <Switch checked={p.pinnedByDefault} onCheckedChange={(v) => set('pinnedByDefault', v)} />
        </Row>
        <Row label="Close when you leave the field" description="Off keeps the popup visible after you click elsewhere on the page (it still closes with Esc or ✕).">
          <Switch checked={p.closeOnBlur} onCheckedChange={(v) => set('closeOnBlur', v)} />
        </Row>
        <Row label="Reopen when you click the field" description="After you close the popup or insert an answer, clicking into the same field brings it back.">
          <Switch checked={p.reopenOnClick} onCheckedChange={(v) => set('reopenOnClick', v)} />
        </Row>
        <Row label="Hide while you type" description="When you start typing your own answer, the popup steps aside. Off keeps it open next to your typing.">
          <Switch checked={p.hideWhileTyping} onCheckedChange={(v) => set('hideWhileTyping', v)} />
        </Row>
        <Row label="Close after inserting" description="Off keeps the popup open after you pick a suggestion, so you can try another.">
          <Switch checked={settings.behavior.closeOnInsert} onCheckedChange={(v) => update((d) => void (d.behavior.closeOnInsert = v))} />
        </Row>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<PanelTop className="size-4" />} title="Size & look" />
        <Row label="Maximum width" description="The popup matches the field's width, up to this limit.">
          <Slider className="w-64" value={settings.appearance.dropdownMaxWidth} min={300} max={720} step={20} onChange={(v) => update((d) => void (d.appearance.dropdownMaxWidth = v))} format={(v) => `${v}px`} />
        </Row>
        <Row label="Maximum height" description="Longer lists scroll inside the popup.">
          <Slider className="w-64" value={p.maxHeight} min={240} max={900} step={20} onChange={(v) => set('maxHeight', v)} format={(v) => `${v}px`} />
        </Row>
        <Row label="Opacity" description="See the page through the popup. It becomes fully solid while your mouse is over it.">
          <Slider className="w-64" value={p.opacity} min={50} max={100} step={5} onChange={(v) => set('opacity', v)} format={(v) => `${v}%`} />
        </Row>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<Eye className="size-4" />} title="What the popup shows" description="Turn parts off for a more minimal popup." />
        <Row label="Header" description="FormPilot's title, the detected question, and the pin, ⋯ and close buttons. When hidden, a slim grip bar stays for dragging.">
          <Switch checked={p.showHeader} onCheckedChange={(v) => set('showHeader', v)} />
        </Row>
        <Row label="Action buttons" description="Regenerate, Shorter, Longer, Refine… and Save my answer.">
          <Switch checked={p.showActions} onCheckedChange={(v) => set('showActions', v)} />
        </Row>
        <Row label="Footer" description="Keyboard hints, which AI answered and how fast.">
          <Switch checked={p.showFooter} onCheckedChange={(v) => set('showFooter', v)} />
        </Row>
        <Row label="Source badges" description="The small Memory / History / AI tags on each suggestion.">
          <Switch checked={p.showBadges} onCheckedChange={(v) => set('showBadges', v)} />
        </Row>
        <Row label="Group labels" description="“From your memory” and “AI suggestions” headings.">
          <Switch checked={p.showGroupLabels} onCheckedChange={(v) => set('showGroupLabels', v)} />
        </Row>
      </Card>

      <Card>
        <CardHeader icon={<Keyboard className="size-4" />} title="Keyboard" />
        <Row
          label={
            <span className="inline-flex items-center gap-1.5">
              <Kbd>Alt</Kbd> + <Kbd>1</Kbd>…<Kbd>9</Kbd> inserts a suggestion
            </span>
          }
          description="Pick the 1st…9th suggestion directly. Numbers are shown next to each suggestion."
        >
          <Switch checked={p.numberShortcuts} onCheckedChange={(v) => set('numberShortcuts', v)} />
        </Row>
        <Row
          label={
            <span className="inline-flex items-center gap-1.5">
              <Kbd>Tab</Kbd> inserts the highlighted suggestion
            </span>
          }
          description="Off: Tab moves to the next field as usual (Enter inserts)."
        >
          <Switch checked={p.tabAccepts} onCheckedChange={(v) => set('tabAccepts', v)} />
        </Row>
      </Card>
    </>
  );
}
