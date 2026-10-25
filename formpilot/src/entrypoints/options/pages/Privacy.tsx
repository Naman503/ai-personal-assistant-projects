import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, Download, Upload, Trash2, Lock, KeyRound } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Input, PageHeader, Row, Switch } from '@/components/ui';
import { useVault } from '../vault-ui';
import { changePassword, lockVault, passwordProblem, resetVault, setVaultMode } from '@/lib/vault';
import { db, bumpMemoryVersion } from '@/lib/memory/db';
import { DEFAULT_SETTINGS, parseSettings, saveSettings } from '@/lib/settings';
import { rpc, track } from '@/lib/messages';
import type { PageProps } from '../App';

function SecurityCard({ update }: { update: PageProps['update'] }) {
  const vault = useVault();
  const st = vault.status;
  const [changing, setChanging] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setUp = () => vault.requireDek('').then(() => {}).catch(() => {});

  const toggleStrict = async (on: boolean) => {
    try {
      const dek = await vault.requireDek('Enter your password to change how keys are locked.');
      await setVaultMode(dek, on ? 'strict' : 'standard');
      track('options_action', { action: 'vault_mode_changed' });
      await vault.refresh();
      toast.success(on ? 'Keys will lock when the browser restarts' : 'Keys stay usable after restarts');
    } catch {
      /* cancelled */
    }
  };

  const startChange = async () => {
    try {
      await vault.requireDek('Enter your current password.');
      setChanging(true);
      setPw('');
      setPw2('');
      setErr(null);
    } catch {
      /* cancelled */
    }
  };

  const saveNew = async () => {
    const problem = passwordProblem(pw);
    if (problem) return setErr(problem);
    if (pw !== pw2) return setErr("Passwords don't match.");
    setBusy(true);
    try {
      const dek = await vault.requireDek('Enter your current password.');
      await changePassword(dek, pw);
      track('options_action', { action: 'password_changed' });
      setChanging(false);
      toast.success('Password changed');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!confirm('Remove your password AND every saved API key? You will need to paste your keys again.')) return;
    await resetVault();
    vault.lockView();
    update((d) =>
      d.providers.forEach((p) => {
        p.hasKey = false;
        p.apiKey = '';
      }),
    );
    await vault.refresh();
    toast.success('Password and saved keys removed');
  };

  return (
    <Card className="mb-5">
      <CardHeader
        icon={<KeyRound className="size-4" />}
        title="API key protection"
        description="Your AI provider keys are encrypted with your FormPilot password (AES-256-GCM, PBKDF2 with 600,000 iterations). The password itself is never stored."
      />
      <Row label="Password" description={st?.exists ? `Set. Protecting ${st.keys.length} key${st.keys.length === 1 ? '' : 's'}. Seeing, changing or removing a key asks for it.` : 'Not set yet. You will be asked to create one when you save your first key.'}>
        {st?.exists ? (
          <div className="flex items-center gap-2">
            <Badge tone="green">
              <Lock className="size-3" /> Protected
            </Badge>
            <Button onClick={startChange}>Change password</Button>
          </div>
        ) : (
          <Button variant="primary" onClick={setUp}>
            <ShieldCheck className="size-3.5" /> Set a password
          </Button>
        )}
      </Row>
      {changing && (
        <div className="animate-fade-up space-y-2 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800/70">
          <Input type="password" autoFocus placeholder="New password or PIN (4+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} />
          <Input type="password" placeholder="Confirm new password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void saveNew()} />
          {err && <p className="text-[13px] text-red-600">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setChanging(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={saveNew}>
              Save new password
            </Button>
          </div>
        </div>
      )}
      {st?.exists && (
        <>
          <Row
            label="Lock after the browser restarts"
            description={
              st.mode === 'strict'
                ? 'Strongest: after every browser restart, AI suggestions pause until you enter the password once. Protects against anyone with technical access to this computer.'
                : 'Off: AI keeps working without asking. Only viewing or changing keys needs the password. Protects against anyone opening these settings.'
            }
          >
            <Switch checked={st.mode === 'strict'} onCheckedChange={toggleStrict} />
          </Row>
          <Row
            label="Lock now"
            description={
              st.mode === 'strict'
                ? st.usable
                  ? 'Unlocked for this browser session. Lock to pause AI suggestions and hide keys until you enter the password again.'
                  : 'Locked: AI suggestions that need a saved key are paused.'
                : 'Hide keys on this page right away (it also locks by itself after 5 minutes).'
            }
          >
            <Button
              onClick={async () => {
                vault.lockView();
                if (st.mode === 'strict') await lockVault();
                await vault.refresh();
                toast.success('Locked');
              }}
            >
              <Lock className="size-3.5" /> Lock
            </Button>
          </Row>
          <Row label="Forgot your password?" description="Reset removes the password and all saved API keys. Memory, facts and settings are kept.">
            <Button variant="ghost" className="text-red-600" onClick={reset}>
              Reset password &amp; keys
            </Button>
          </Row>
        </>
      )}
    </Card>
  );
}

export function Privacy({ settings, update }: PageProps) {
  const p = settings.privacy;
  const set = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => update((d) => void (d.privacy[k] = v));
  const fileRef = useRef<HTMLInputElement>(null);

  const exportAll = async () => {
    const data = {
      app: 'formpilot',
      exportedAt: new Date().toISOString(),
      // API keys are never exported; they stay encrypted on this device.
      settings: { ...settings, providers: settings.providers.map((x) => ({ ...x, apiKey: '', hasKey: false })) },
      docs: await db().docs.toArray(),
      facts: await db().facts.toArray(),
      history: await db().history.toArray(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `formpilot-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    track('options_action', { action: 'backup_exported' });
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const importAll = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'formpilot') throw new Error('Not a FormPilot backup file');
      if (!confirm('Import this backup? Documents, facts and history will be merged; settings will be replaced.')) return;
      const s = parseSettings(data.settings);
      // Keys are not in backups: keep whatever this device already has stored for each provider.
      s.providers = s.providers.map((x) => {
        const cur = settings.providers.find((y) => y.id === x.id);
        return { ...x, apiKey: x.apiKey || cur?.apiKey || '', hasKey: cur?.hasKey ?? false };
      });
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
      track('options_action', { action: 'backup_imported' });
      toast.success('Backup imported');
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      track('options_action', { action: 'backup_import_failed' });
      toast.error(`Import failed: ${(e as Error).message}`);
    }
  };

  const wipe = async () => {
    if (!confirm('Delete ALL FormPilot data: documents, facts, history, cache and settings? This cannot be undone.')) return;
    track('options_action', { action: 'wipe_all' });
    await Promise.all([db().docs.clear(), db().chunks.clear(), db().facts.clear(), db().history.clear(), db().cache.clear(), resetVault()]);
    await bumpMemoryVersion();
    await saveSettings(DEFAULT_SETTINGS);
    await rpc({ type: 'memory-changed' }).catch(() => {});
    toast.success('All data deleted');
    setTimeout(() => location.reload(), 600);
  };

  return (
    <>
      <PageHeader title="Privacy & Data" description="Your memory is stored locally in this browser. Only the excerpts relevant to a field are sent to the AI provider you choose, plus anonymous usage counts if you leave that on." />

      <SecurityCard update={update} />

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
        <Row
          label="Share anonymous usage"
          description="Which features, shortcuts and settings are used, daily counts (suggestions shown and accepted, fills, corrections), outcomes, error categories, latency and size buckets, the provider type and crash stacks from FormPilot's own code, with a random id. Never field contents, typed text, pages or sites, memory, file names, models, provider URLs or keys, and never in Local-only mode. Turning it off deletes what was sent."
        >
          <Switch checked={p.shareUsage} onCheckedChange={(v) => set('shareUsage', v)} />
        </Row>
        <Row label="Sensitive fields" description="Passwords, payment cards, CVV, OTP / 2FA, CAPTCHA, PINs, government IDs and bank details are never read, sent or filled.">
          <span className="flex items-center gap-1.5 text-[13px] text-emerald-600">
            <Lock className="size-3.5" /> Enforced
          </span>
        </Row>
        <Row label="API keys" description="Encrypted with your password, never synced or exported, and only ever sent to their own provider.">
          <span className="flex items-center gap-1.5 text-[13px] text-emerald-600">
            <Lock className="size-3.5" /> Local
          </span>
        </Row>
      </Card>

      <Card>
        <CardHeader title="Backup & reset" />
        <Row label="Export" description="Download settings, documents, facts and learned answers as JSON. API keys are never included.">
          <div className="flex gap-2">
            <Button onClick={() => exportAll()}>
              <Download className="size-3.5" /> Export
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
