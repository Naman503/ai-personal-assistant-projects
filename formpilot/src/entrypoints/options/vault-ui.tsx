import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Eye, EyeOff, KeyRound, Loader2, Lock, ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Input, Switch } from '@/components/ui';
import { cn } from '@/components/ui/cn';
import {
  createVault,
  isSimplePin,
  passwordProblem,
  TooManyAttemptsError,
  passwordStrength,
  resetVault,
  unlockVault,
  vaultStatus,
  WrongPasswordError,
  type VaultMode,
  type VaultStatus,
} from '@/lib/vault';

/** How long the settings page stays unlocked for viewing/editing keys after you enter the password. */
const VIEW_UNLOCK_MS = 5 * 60_000;

type DialogKind = { kind: 'create' | 'unlock'; reason: string };

interface VaultCtx {
  status: VaultStatus | null;
  /** True while keys can be viewed/edited here without asking again. */
  unlocked: boolean;
  refresh(): Promise<void>;
  /** Get the data key, prompting for the password (or for creating one) when needed. Rejects if cancelled. */
  requireDek(reason: string): Promise<CryptoKey>;
  lockView(): void;
  /** Called after a reset so pages can clear their hasKey flags. */
  onReset(fn: () => void): () => void;
}

const Ctx = createContext<VaultCtx | null>(null);

export function useVault(): VaultCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVault must be used inside <VaultProvider>');
  return v;
}

function PasswordField({ value, onChange, placeholder, autoFocus, id }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean; id?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input id={id} type={show ? 'text' : 'password'} value={value} autoFocus={autoFocus} placeholder={placeholder} autoComplete="new-password" className="h-10 pr-10" onChange={(e) => onChange(e.target.value)} />
      <button type="button" tabIndex={-1} className="absolute inset-y-0 right-0 grid w-10 place-items-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

function StrengthMeter({ pw }: { pw: string }) {
  const s = passwordStrength(pw);
  const labels = [pw.length >= 4 ? 'Simple PIN' : 'Too short', 'Okay', 'Good', 'Strong', 'Strong'];
  const colors = [pw.length >= 4 ? 'bg-amber-400' : 'bg-red-500', 'bg-amber-400', 'bg-lime-500', 'bg-emerald-500', 'bg-emerald-600'];
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn('h-1.5 flex-1 rounded-full transition-colors', pw && i < Math.max(1, s) ? colors[s] : 'bg-zinc-200 dark:bg-zinc-700')} />
        ))}
      </div>
      <span className="w-20 text-right text-[11px] text-zinc-500">{pw ? labels[s] : ''}</span>
    </div>
  );
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [dek, setDek] = useState<CryptoKey | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [strict, setStrict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const pending = useRef<{ resolve: (k: CryptoKey) => void; reject: (e: Error) => void } | null>(null);
  const lockTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const resetListeners = useRef(new Set<() => void>());

  const refresh = useCallback(async () => setStatus(await vaultStatus()), []);
  useEffect(() => {
    void refresh();
    const on = (c: Record<string, chrome.storage.StorageChange>) => {
      if ('vault' in c || 'vaultSecrets' in c || 'vaultDevice' in c || 'vaultSession' in c) void refresh();
    };
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, [refresh]);

  const lockView = useCallback(() => {
    clearTimeout(lockTimer.current);
    setDek(null);
  }, []);

  const keepUnlocked = useCallback(
    (k: CryptoKey) => {
      setDek(k);
      clearTimeout(lockTimer.current);
      lockTimer.current = setTimeout(lockView, VIEW_UNLOCK_MS);
    },
    [lockView],
  );

  const requireDek = useCallback(
    async (reason: string) => {
      if (dek) {
        keepUnlocked(dek);
        return dek;
      }
      const st = await vaultStatus();
      setStatus(st);
      setPw('');
      setPw2('');
      setError(null);
      setConfirmReset(false);
      setStrict(false);
      setDialog({ kind: st.exists ? 'unlock' : 'create', reason });
      return new Promise<CryptoKey>((resolve, reject) => (pending.current = { resolve, reject }));
    },
    [dek, keepUnlocked],
  );

  const close = (cancelled: boolean) => {
    setDialog(null);
    setPw('');
    setPw2('');
    if (cancelled) pending.current?.reject(new Error('cancelled'));
    pending.current = null;
  };

  const submit = async () => {
    if (!dialog) return;
    setError(null);
    if (dialog.kind === 'create') {
      const problem = passwordProblem(pw);
      if (problem) return setError(problem);
      if (pw !== pw2) return setError("Passwords don't match.");
    }
    setBusy(true);
    try {
      const k = dialog.kind === 'create' ? await createVault(pw, (strict ? 'strict' : 'standard') as VaultMode) : await unlockVault(pw);
      keepUnlocked(k);
      await refresh();
      if (dialog.kind === 'create') toast.success('Password set. Your API keys are now encrypted.');
      pending.current?.resolve(k);
      close(false);
    } catch (e) {
      setError(
        e instanceof WrongPasswordError
          ? `Wrong password. ${e.attemptsLeft && e.attemptsLeft <= 3 ? `${e.attemptsLeft} attempt${e.attemptsLeft > 1 ? 's' : ''} left before a short pause.` : 'Try again.'}`
          : e instanceof TooManyAttemptsError
            ? `Too many wrong attempts. Try again in ${e.retryInSec} seconds.`
            : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const doReset = async () => {
    await resetVault();
    lockView();
    await refresh();
    resetListeners.current.forEach((fn) => fn());
    toast.success('Password and saved API keys removed. Add your keys again.');
    close(true);
  };

  const onReset = useCallback((fn: () => void) => {
    resetListeners.current.add(fn);
    return () => resetListeners.current.delete(fn);
  }, []);

  return (
    <Ctx.Provider value={{ status, unlocked: !!dek, refresh, requireDek, lockView, onReset }}>
      {children}
      <Dialog.Root open={!!dialog} onOpenChange={(o) => !o && close(true)}>
        <Dialog.Portal>
          <Dialog.Overlay className="animate-fade-up fixed inset-0 z-50 bg-zinc-950/40 backdrop-blur-[2px]" />
          <Dialog.Content
            className="animate-fade-up fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).querySelector('input')?.focus();
            }}
          >
            <div className="mb-4 grid size-11 place-items-center rounded-xl bg-brand/10 text-brand">{dialog?.kind === 'create' ? <ShieldCheck className="size-5" /> : <Lock className="size-5" />}</div>
            <Dialog.Title className="text-lg font-semibold tracking-tight">{dialog?.kind === 'create' ? 'Protect your API keys' : 'Enter your FormPilot password'}</Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-relaxed text-zinc-500">
              {dialog?.kind === 'create'
                ? 'Create a password or a 4-digit PIN. Your keys are encrypted with it, and it is needed to see, change or remove them. FormPilot never stores it.'
                : dialog?.reason}
            </Dialog.Description>

            {!confirmReset ? (
              <form
                className="mt-5 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <div>
                  <PasswordField value={pw} onChange={setPw} placeholder={dialog?.kind === 'create' ? 'New password or PIN' : 'Password'} autoFocus />
                  {dialog?.kind === 'create' && <StrengthMeter pw={pw} />}
                  {dialog?.kind === 'create' && isSimplePin(pw) && pw.length >= 4 && (
                    <p className="mt-1.5 text-xs text-zinc-500">
                      A short PIN is fine for keeping people out of these settings. If you turn on the lock below, a longer password is safer.
                    </p>
                  )}
                </div>
                {dialog?.kind === 'create' && (
                  <>
                    <PasswordField value={pw2} onChange={setPw2} placeholder="Confirm password or PIN" />
                    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
                      <Switch checked={strict} onCheckedChange={setStrict} />
                      <span className="text-[13px]">
                        <span className="font-medium">Also lock after the browser restarts</span>
                        <span className="block text-xs text-zinc-500">Strongest protection: AI suggestions pause until you enter the password once per browser session. You can change this later in Privacy &amp; Data.</span>
                      </span>
                    </label>
                    <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                      There is no way to recover a forgotten password. You would have to reset it and enter your API keys again.
                    </p>
                  </>
                )}
                {error && <p className="text-[13px] text-red-600 dark:text-red-400">{error}</p>}
                <div className="flex items-center gap-2 pt-1">
                  {dialog?.kind === 'unlock' && (
                    <button type="button" className="text-xs text-zinc-500 hover:text-red-600" onClick={() => setConfirmReset(true)}>
                      Forgot password?
                    </button>
                  )}
                  <div className="ml-auto flex gap-2">
                    <Button type="button" variant="ghost" onClick={() => close(true)}>
                      Cancel
                    </Button>
                    <Button type="submit" variant="primary" disabled={busy || !pw}>
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
                      {dialog?.kind === 'create' ? 'Set password' : 'Unlock'}
                    </Button>
                  </div>
                </div>
              </form>
            ) : (
              <div className="mt-5 space-y-3">
                <p className="rounded-lg bg-red-50 px-3 py-2.5 text-[13px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
                  Resetting removes your password <b>and every saved API key</b>. Your memory, facts and settings are kept. You will need to paste your keys again.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setConfirmReset(false)}>
                    Back
                  </Button>
                  <Button variant="danger" onClick={doReset}>
                    Reset password &amp; keys
                  </Button>
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Ctx.Provider>
  );
}
