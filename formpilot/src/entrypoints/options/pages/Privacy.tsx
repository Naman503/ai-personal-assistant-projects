import { useRef } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, Download, Upload, Trash2, Lock } from 'lucide-react';
import { Button, Card, CardHeader, PageHeader, Row, Switch } from '@/components/ui';
import { db, bumpMemoryVersion } from '@/lib/memory/db';
import { DEFAULT_SETTINGS, parseSettings, saveSettings } from '@/lib/settings';
import { rpc } from '@/lib/messages';
import type { PageProps } from '../App';

export function Privacy({ settings, update }: PageProps) {
  const p = settings.privacy;
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => update((d) => void (d.privacy[k] = v));
  const fileRef = useRef<HTMLInputElement>(null);

  const exportAll = async (withKeys: boolean) => {
    const data = {
      app: 'formpilot',
      exportedAt: new Date().toISOString(),
      settings: withKeys ? settings : { ...settings, providers: settings.providers.map((x) => ({ ...x, apiKey: '' })) },
      docs: await db().docs.toArray(),
      facts: await db().facts.toArray(),
      history: await db().history.toArray(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `formpilot-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const importAll = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'formpilot') throw new Error('Not a FormPilot backup file');
      if (!confirm('Import this backup? Documents, facts and history will be merged; settings will be replaced.')) return;
      const s = parseSettings(data.settings);
      // Keep existing keys when the backup has none.
      s.providers = s.providers.map((x) => ({ ...x, apiKey: x.apiKey || settings.providers.find((y) => y.id === x.id)?.apiKey || '' }));
      await saveSettings(s);
      await db().transaction('rw', db().docs, db().facts, db().history, async () => {
        if (Array.isArray(data.docs)) await db().docs.bulkPut(data.docs);
        if (Array.isArray(data.facts)) await db().facts.bulkPut(data.facts);
        if (Array.isArray(data.history)) await db().history.bulkPut(data.history);
      });
      // Re-chunk imported docs.
      const { rechunkAll } = await import('@/lib/memory/ingest');
      await rechunkAll({ chunkSize: s.memory.chunkSize, chunkOverlap: s.memory.chunkOverlap });
      await rpc({ type: 'memory-changed' });
      toast.success('Backup imported');
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      toast.error(`Import failed: ${(e as Error).message}`);
    }
  };

  const wipe = async () => {
    if (!confirm('Delete ALL FormPilot data: documents, facts, history, cache and settings? This cannot be undone.')) return;
    await Promise.all([db().docs.clear(), db().chunks.clear(), db().facts.clear(), db().history.clear(), db().cache.clear()]);
    await bumpMemoryVersion();
    await saveSettings(DEFAULT_SETTINGS);
    await rpc({ type: 'memory-changed' }).catch(() => {});
    toast.success('All data deleted');
    setTimeout(() => location.reload(), 600);
  };

  return (
    <>
      <PageHeader title="Privacy & Data" description="Your memory is stored locally in this browser. Only the excerpts relevant to a field are sent to the AI provider you choose." />

      <Card className="mb-5">
        <CardHeader icon={<ShieldCheck className="size-4" />} title="Protection" />
        <Row label="Redact secrets before sending" description="Masks card numbers (Luhn-checked), IBANs, API keys, private keys and “password: …” lines found in memory or on the page.">
          <Switch checked={p.redactSecrets} onCheckedChange={(v) => set('redactSecrets', v)} />
        </Row>
        <Row label="Local-only mode" description="Only on-device providers (Chrome AI, Ollama, LM Studio) are used.">
          <Switch checked={p.localOnly} onCheckedChange={(v) => set('localOnly', v)} />
        </Row>
        <Row label="Send page address" description="Include the page URL (without query string) for context.">
          <Switch checked={p.sendPageUrl} onCheckedChange={(v) => set('sendPageUrl', v)} />
        </Row>
        <Row label="Sensitive fields" description="Passwords, payment cards, CVV, OTP / 2FA, CAPTCHA, PINs, government IDs and bank details are never read, sent or filled.">
          <span className="flex items-center gap-1.5 text-[13px] text-emerald-600">
            <Lock className="size-3.5" /> Enforced
          </span>
        </Row>
        <Row label="API keys" description="Stored in this browser's local extension storage, never synced, and only ever sent to their own provider.">
          <span className="flex items-center gap-1.5 text-[13px] text-emerald-600">
            <Lock className="size-3.5" /> Local
          </span>
        </Row>
      </Card>

      <Card>
        <CardHeader title="Backup & reset" />
        <Row label="Export" description="Download settings, documents, facts and learned answers as JSON.">
          <div className="flex gap-2">
            <Button onClick={() => exportAll(false)}>
              <Download className="size-3.5" /> Export
            </Button>
            <Button variant="ghost" onClick={() => exportAll(true)} title="Includes API keys in plain text">
              With API keys
            </Button>
          </div>
        </Row>
        <Row label="Import" description="Restore from a FormPilot backup file.">
          <>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && importAll(e.target.files[0])} />
            <Button onClick={() => fileRef.current?.click()}>
              <Upload className="size-3.5" /> Import
            </Button>
          </>
        </Row>
        <Row label="Delete everything" description="Wipe all FormPilot data from this browser.">
          <Button variant="danger" onClick={wipe}>
            <Trash2 className="size-3.5" /> Delete all data
          </Button>
        </Row>
      </Card>
    </>
  );
}
