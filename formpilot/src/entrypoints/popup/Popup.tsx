import { useCallback, useEffect, useState } from 'react';
import {
  Settings2,
  Brain,
  Globe,
  Cpu,
  ScrollText,
  Mail,
  Lock,
  Bookmark,
  CheckCircle2,
  Wand2,
  ExternalLink,
  Briefcase,
  Send,
  Bell,
  CalendarClock,
  Star,
  Copy,
  Footprints,
  Users,
  Loader2,
  ChevronRight,
  ListChecks,
  Square,
  RefreshCw,
  Bot,
  Play,
} from 'lucide-react';
import { Switch } from '@/components/ui';
import { useApplyAppearance, useSettings } from '@/hooks/useSettings';
import { siteAllowed } from '@/lib/fields/eligibility';
import { providerConfigured, isLocalProvider } from '@/lib/settings';
import { hostMatches } from '@/lib/util';
import { isLinkedInJobList } from '@/lib/queue';
import { rpc, track, type Stats } from '@/lib/messages';
import { AUTHOR } from '@/lib/about';
import { vaultStatus } from '@/lib/vault';
import type { JobInfo } from '@/lib/job';
import type { TrackerLookup, TrackerSummary } from '@/lib/tracker';
import { describe as describeAutopilot, useAutopilot } from '@/hooks/useAutopilot';

function openOptions(section?: string) {
  const action = (section ?? 'settings').split('?')[0];
  track('toolbar_action', { action: ['providers', 'memory', 'logs', 'about'].includes(action) ? action : 'settings' });
  void rpc({ type: 'open-options', section }).then(() => window.close());
}

const fmtDate = (s?: string) => (s ? new Date(s + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Stars({ n, auto }: { n: number; auto?: boolean }) {
  if (!n) return null;
  return (
    <span className={`inline-flex items-center gap-px ${auto ? 'opacity-60' : ''}`} title={auto ? `Auto fit ${n}/5` : `Fit ${n}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`size-3 ${i <= n ? 'fill-amber-400 text-amber-400' : 'fill-zinc-200 text-zinc-200 dark:fill-zinc-700 dark:text-zinc-700'}`} />
      ))}
    </span>
  );
}

function Logo({ src, name }: { src?: string; name: string }) {
  const [bad, setBad] = useState(false);
  if (src && !bad) return <img src={src} alt="" onError={() => setBad(true)} className="size-11 shrink-0 rounded-xl border border-zinc-200 bg-white object-contain p-1 dark:border-zinc-700" />;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <div className="grid size-11 shrink-0 place-items-center rounded-xl text-base font-semibold text-white" style={{ background: `hsl(${h} 45% 45%)` }}>
      {(name.trim()[0] || '?').toUpperCase()}
    </div>
  );
}

function Tile({ icon, label, value, hot, onClick }: { icon: React.ReactNode; label: string; value: number | string; hot?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group flex flex-col items-start gap-1 rounded-xl border border-zinc-200 bg-white px-2.5 py-2 text-left transition hover:-translate-y-px hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700">
      <span className={`flex items-center gap-1 text-[10.5px] font-medium ${hot ? 'text-brand' : 'text-zinc-500'}`}>
        {icon}
        {label}
      </span>
      <span className={`text-lg leading-none font-semibold tabular-nums ${hot ? 'text-brand' : ''}`}>{value}</span>
    </button>
  );
}

export function Popup() {
  const { settings, update, loaded } = useSettings();
  useApplyAppearance(settings);
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [locked, setLocked] = useState(false);
  const [job, setJob] = useState<Omit<JobInfo, 'description'> | null>(null);
  const [look, setLook] = useState<TrackerLookup | null>(null);
  const [summary, setSummary] = useState<TrackerSummary | null>(null);
  const [trackerErr, setTrackerErr] = useState('');
  const [busy, setBusy] = useState<'' | 'save-job' | 'mark-applied'>('');
  const [copied, setCopied] = useState(false);
  const { st: ap, call: apCall } = useAutopilot(1500);
  const apNow = describeAutopilot(ap);

  useEffect(() => {
    vaultStatus().then((v) => setLocked(v.exists && v.mode === 'strict' && !v.usable)).catch(() => {});
    chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t ?? null));
    rpc<Stats>({ type: 'stats' }).then(setStats).catch(() => {});
  }, []);

  const trackerOn = loaded && settings.tracker.enabled && !!settings.tracker.url;
  // LinkedIn keeps the job list on screen after Easy Apply changes the address to /jobs/view/…,
  // so ask the page whether it has a list rather than going by the URL alone.
  const onLinkedInJobs = !!tab?.url && /linkedin\.com\/jobs\//.test(tab.url);
  const [pageHasList, setPageHasList] = useState(false);
  const onJobList = onLinkedInJobs && (isLinkedInJobList(tab?.url ?? '') || pageHasList);
  const [queueRunning, setQueueRunning] = useState(false);
  // The page's FormPilot script is missing or older than this popup (the extension was reloaded
  // or updated after the tab opened): commands it doesn't know would be dropped or misread.
  const [pageStale, setPageStale] = useState(false);
  useEffect(() => {
    if (!tab?.id || !onLinkedInJobs) return;
    chrome.tabs
      .sendMessage(tab.id, { type: 'command', name: 'apply-queue-status' }, { frameId: 0 })
      .then((r: { running?: boolean; list?: boolean } | undefined) => {
        if (!r || typeof r.list !== 'boolean') return setPageStale(true);
        setQueueRunning(!!r.running);
        setPageHasList(r.list);
      })
      .catch(() => setPageStale(true));
  }, [tab?.id, onLinkedInJobs]);
  const queueCommand = async (name: 'apply-queue' | 'apply-queue-stop') => {
    if (!tab?.id) return;
    track('toolbar_action', { action: name === 'apply-queue' ? 'queue_start' : 'queue_stop' });
    const r = (await chrome.tabs.sendMessage(tab.id, { type: 'command', name, via: 'toolbar' }, { frameId: 0 }).catch(() => undefined)) as { ok?: boolean } | undefined;
    if (!r?.ok) return setPageStale(true);
    window.close();
  };
  // A newer build sits in the extension folder than the one running (unpacked installs need a reload).
  const [diskVersion, setDiskVersion] = useState<string | null>(null);
  useEffect(() => {
    fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })
      .then((r) => r.json())
      .then((m: { version?: string }) => {
        if (m.version && m.version !== chrome.runtime.getManifest().version) setDiskVersion(m.version);
      })
      .catch(() => {});
  }, []);
  const trackerBase = settings.tracker.url.trim().replace(/\/+$/, '');

  // What job is this page about, and is it already tracked?
  const refreshLookup = useCallback(async (j: Omit<JobInfo, 'description'>) => {
    const r = await rpc<TrackerLookup>({ type: 'tracker-lookup', url: j.url, company: j.company, role: j.role });
    setLook(r);
    return r;
  }, []);
  useEffect(() => {
    if (!tab?.id || !loaded) return;
    chrome.tabs
      .sendMessage(tab.id, { type: 'command', name: 'get-job' }, { frameId: 0 })
      .then((j: Omit<JobInfo, 'description'> | null) => {
        if (!j || !(j.role && j.company)) return;
        setJob(j);
        if (trackerOn) refreshLookup(j).catch((e) => setTrackerErr((e as Error).message));
      })
      .catch(() => {});
  }, [tab?.id, loaded, trackerOn, refreshLookup]);
  useEffect(() => {
    if (!trackerOn) return;
    rpc<TrackerSummary>({ type: 'tracker-summary' })
      .then(setSummary)
      .catch((e) => setTrackerErr((e as Error).message));
  }, [trackerOn]);

  const host = (() => {
    try {
      const u = new URL(tab?.url ?? '');
      return /^https?:$/.test(u.protocol) ? u.hostname : '';
    } catch {
      return '';
    }
  })();
  const blocked = !!host && settings.behavior.blockedSites.some((p) => hostMatches(host, p));
  const activeHere = !!host && siteAllowed(host, settings);
  const providers = settings.providers.filter((p) => providerConfigured(p) && (!settings.privacy.localOnly || isLocalProvider(p)));
  const [reported, setReported] = useState(false);
  useEffect(() => {
    if (!loaded || !tab || reported) return;
    setReported(true);
    track('toolbar_popup_opened', { site_active: activeHere, provider_ready: providers.length > 0, locked });
  }, [loaded, tab, reported, activeHere, providers.length, locked]);

  if (!loaded) return <div className="h-96" />;

  const openTracker = (hash = 'today') => {
    track('toolbar_action', { action: 'open_tracker' });
    void chrome.tabs.create({ url: `${trackerBase}/#${hash}` }).then(() => window.close());
  };
  const sendJobCommand = async (name: 'save-job' | 'mark-applied') => {
    if (!tab?.id || !job) return;
    setBusy(name);
    track('toolbar_action', { action: name === 'save-job' ? 'save_job' : 'mark_applied' });
    await chrome.tabs.sendMessage(tab.id, { type: 'command', name, via: 'toolbar' }, { frameId: 0 }).catch(() => {});
    // The page records it; check the tracker until it shows up.
    for (let i = 0; i < 6; i++) {
      await sleep(700);
      const r = await refreshLookup(job).catch(() => null);
      if (r?.found && (name === 'save-job' || r.status === 'applied' || r.status === 'interview' || r.status === 'offer')) break;
    }
    setBusy('');
  };
  const applied = !!look?.found && ['applied', 'interview', 'offer', 'closed'].includes(look.status ?? '');
  const statusChip = !look ? null : look.found ? (
    <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${applied ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400' : 'bg-brand/10 text-brand'}`}>
      {look.status === 'applied' && look.appliedOn ? `Applied ${fmtDate(look.appliedOn)}` : look.label}
    </span>
  ) : (
    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10.5px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">Not tracked yet</span>
  );
  const btn = 'flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-[12px] font-medium transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800';
  const dueCount = summary?.due.length ?? 0;

  return (
    <div className="bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <div className="relative overflow-hidden border-b border-zinc-200/70 bg-white px-4 pt-4 pb-3.5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="pointer-events-none absolute -top-20 -right-12 size-48 rounded-full bg-brand/25 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-16 size-40 rounded-full bg-fuchsia-500/10 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <img src={chrome.runtime.getURL('/icon/48.png')} alt="" className="size-9 rounded-xl shadow-md shadow-brand/30" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] leading-tight font-semibold tracking-tight">FormPilot</div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <span className={`size-1.5 rounded-full ${settings.behavior.enabled && activeHere ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
              {settings.behavior.enabled ? (activeHere ? `Active on ${host.replace(/^www\./, '')}` : host ? 'Paused on this site' : 'Not available on this page') : 'Paused everywhere'}
            </div>
          </div>
          <Switch
            checked={settings.behavior.enabled}
            onCheckedChange={(v) => {
              track('toolbar_action', { action: 'toggle_extension' });
              update((d) => void (d.behavior.enabled = v));
            }}
          />
        </div>
      </div>

      <div className="space-y-2.5 p-3">
        {/* The job on this page */}
        {job && (
          <div className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex gap-3">
              <Logo src={look?.logo || job.logoUrl} name={job.company} />
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[13px] leading-snug font-semibold">{job.role}</div>
                <div className="truncate text-xs text-zinc-500">
                  {job.company}
                  {job.location ? ` · ${job.location}` : ''}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {trackerOn ? statusChip : null}
                  <Stars n={look?.fit || look?.fitAuto || 0} auto={!look?.fit} />
                  {!!look?.people && (
                    <span className="inline-flex items-center gap-1 text-[10.5px] text-zinc-500">
                      <Users className="size-3" />
                      {look.people}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {look?.fitWhy?.length && !applied ? <div className="mt-2 line-clamp-2 text-[11px] text-zinc-500">{look.fitWhy.join(' · ')}</div> : null}
            {trackerOn ? (
              <div className="mt-2.5 flex gap-1.5">
                {!look?.found && (
                  <button className={btn} disabled={!!busy} onClick={() => void sendJobCommand('save-job')}>
                    {busy === 'save-job' ? <Loader2 className="size-3.5 animate-spin" /> : <Bookmark className="size-3.5 text-brand" />}
                    Save
                  </button>
                )}
                {!applied && (
                  <button className={btn} disabled={!!busy} onClick={() => void sendJobCommand('mark-applied')}>
                    {busy === 'mark-applied' ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5 text-emerald-600" />}I applied
                  </button>
                )}
                {look?.linkedinNote ? (
                  <button
                    className={btn}
                    onClick={() => {
                      void navigator.clipboard.writeText(look.linkedinNote!).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      });
                    }}
                    title="The LinkedIn connection note the autopilot wrote for this job"
                  >
                    <Copy className="size-3.5" />
                    {copied ? 'Copied' : 'Note'}
                  </button>
                ) : null}
                {look?.found && (
                  <button className={btn} onClick={() => openTracker(`pipeline?open=app:${look.id}`)}>
                    <ExternalLink className="size-3.5" />
                    Open
                  </button>
                )}
              </div>
            ) : null}
          </div>
        )}

        {diskVersion ? (
          <button
            className="flex w-full items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-left text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
            onClick={() => chrome.runtime.reload()}
          >
            <RefreshCw className="size-5" />
            <div className="flex-1">
              <div className="text-[13.5px] font-semibold">Reload FormPilot to finish updating</div>
              <div className="text-[11px] opacity-80">
                {chrome.runtime.getManifest().version} is running; {diskVersion} is installed. Then reload your tabs.
              </div>
            </div>
          </button>
        ) : pageStale && tab?.id ? (
          <button
            className="flex w-full items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-left text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
            onClick={() => {
              void chrome.tabs.reload(tab.id!);
              window.close();
            }}
          >
            <RefreshCw className="size-5" />
            <div className="flex-1">
              <div className="text-[13.5px] font-semibold">Reload this tab</div>
              <div className="text-[11px] opacity-80">It still has an older FormPilot, so the apply queue can't run here yet.</div>
            </div>
          </button>
        ) : null}

        {/* Apply queue, on LinkedIn job lists */}
        {onJobList ? (
          <button
            className="flex w-full items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-3.5 py-3 text-left shadow-sm transition hover:border-brand/40 dark:border-zinc-800 dark:bg-zinc-900"
            onClick={() => void queueCommand(queueRunning ? 'apply-queue-stop' : 'apply-queue')}
          >
            {queueRunning ? <Square className="size-5 text-rose-500" /> : <ListChecks className="size-5 text-brand" />}
            <div className="flex-1">
              <div className="text-[13.5px] font-semibold">{queueRunning ? 'Stop the apply queue' : 'Apply to this list'}</div>
              <div className="text-[11px] text-zinc-500">
                {queueRunning ? 'Finishes nothing on its own; you can resume later' : `Easy Apply jobs one by one; you press Submit · ${settings.tracker.queueDailyCap}/day`}
              </div>
            </div>
          </button>
        ) : null}

        {/* Autopilot: applies on its own in a separate window */}
        {settings.tracker.enabled ? (
          <div className="rounded-2xl border border-zinc-200 bg-white px-3.5 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-3">
              <Bot className={`size-5 ${ap?.running ? 'text-emerald-500' : 'text-zinc-400'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-[13.5px] font-semibold">
                  <span className="truncate">Autopilot · {ap?.running ? apNow.title : 'off'}</span>
                  {settings.autopilot.dryRun ? <span className="shrink-0 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">dry run</span> : null}
                </div>
                <div className="line-clamp-2 text-[11px] text-zinc-500" title={apNow.detail}>
                  {ap ? `${ap.day.sent} sent · ${ap.day.dry} would apply · ${ap.day.skipped} skipped today · ${apNow.detail}` : 'Applies in its own window, in small batches'}
                </div>
              </div>
              {ap?.running ? (
                <>
                  {apNow.canSkip ? (
                    <button className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Skip this break" onClick={() => void apCall('run-now')}>
                      <Play className="size-4" />
                    </button>
                  ) : null}
                  <button className="rounded-lg p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950" title="Pause (remembers where it is)" onClick={() => void apCall('pause')}>
                    <Square className="size-4" />
                  </button>
                </>
              ) : (
                <button className="rounded-lg bg-brand px-2.5 py-1 text-[12px] font-semibold text-white hover:brightness-110" onClick={() => void apCall('start')}>
                  {ap?.phase === 'paused' ? 'Resume' : 'Start'}
                </button>
              )}
            </div>
            <button className="mt-1.5 text-[11px] font-medium text-brand hover:underline" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#autopilot') }).then(() => window.close())}>
              Details and settings →
            </button>
          </div>
        ) : null}

        {/* Fill */}
        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <button
            className="flex w-full items-center gap-3 bg-gradient-to-br from-brand to-fuchsia-600 px-3.5 py-3 text-left text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!activeHere || !tab?.id}
            onClick={async () => {
              if (!tab?.id) return;
              track('toolbar_action', { action: 'fill_form' });
              await chrome.tabs.sendMessage(tab.id, { type: 'command', name: 'fill-form', via: 'toolbar' }).catch(() => {});
              window.close();
            }}
          >
            <Wand2 className="size-5" />
            <div className="flex-1">
              <div className="text-[13.5px] font-semibold">Fill this form</div>
              <div className="text-[11px] text-white/75">Click into the form first</div>
            </div>
            <kbd className="rounded-md bg-white/15 px-1.5 py-0.5 font-mono text-[10px] text-white/90">Alt⇧J</kbd>
          </button>
          <label className="flex cursor-pointer items-center gap-2.5 px-3.5 py-2.5">
            <Footprints className="size-4 text-zinc-400" />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium">Walk to Submit</div>
              <div className="text-[11px] text-zinc-500">Press Next on each step, stop at Submit</div>
            </div>
            <Switch
              checked={settings.tracker.walkToSubmit}
              onCheckedChange={(v) => {
                track('toolbar_action', { action: 'toggle_walk' });
                update((d) => void (d.tracker.walkToSubmit = v));
              }}
            />
          </label>
        </div>

        {/* Today, from the tracker */}
        {trackerOn ? (
          <div>
            <div className="mb-1.5 flex items-center justify-between px-0.5">
              <span className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">Today</span>
              <button className="flex items-center gap-0.5 text-[11px] font-medium text-brand hover:underline" onClick={() => openTracker('today')}>
                Open tracker <ChevronRight className="size-3" />
              </button>
            </div>
            {summary ? (
              <div className="grid grid-cols-4 gap-1.5">
                <Tile icon={<Briefcase className="size-3" />} label="Apply" value={summary.toApply} onClick={() => openTracker('today')} />
                <Tile icon={<Send className="size-3" />} label="Send" value={summary.toSend} hot={summary.toSend > 0} onClick={() => openTracker('approvals')} />
                <Tile icon={<Bell className="size-3" />} label="Follow" value={dueCount} hot={dueCount > 0} onClick={() => openTracker('followups')} />
                <Tile icon={<CalendarClock className="size-3" />} label="Interv." value={summary.interviews.length} hot={summary.interviews.length > 0} onClick={() => openTracker('followups')} />
              </div>
            ) : trackerErr ? (
              <button className="w-full rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-left text-[11.5px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" onClick={() => openOptions('behavior')}>
                {trackerErr}
              </button>
            ) : (
              <div className="grid grid-cols-4 gap-1.5">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-[52px] animate-pulse rounded-xl bg-zinc-200/70 dark:bg-zinc-800" />
                ))}
              </div>
            )}
          </div>
        ) : (
          <button className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-zinc-300 bg-white px-3 py-2.5 text-left transition hover:border-brand/50 dark:border-zinc-700 dark:bg-zinc-900" onClick={() => openOptions('behavior')}>
            <Briefcase className="size-4 text-brand" />
            <div className="flex-1">
              <div className="text-[12.5px] font-medium">Track your applications</div>
              <div className="text-[11px] text-zinc-500">Connect a job tracker to record every apply</div>
            </div>
            <ChevronRight className="size-4 text-zinc-300" />
          </button>
        )}

        {/* Status tiles */}
        <div className="grid grid-cols-2 gap-1.5">
          <button className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-2.5 py-2 text-left transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900" onClick={() => openOptions(locked ? 'providers?unlock=1' : 'providers')}>
            <Cpu className="size-4 shrink-0 text-zinc-400" />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium">AI</div>
              <div className="truncate text-[10.5px] text-zinc-500">{providers.length ? providers[0].label : 'Not set up'}</div>
            </div>
            {locked ? <Lock className="size-3.5 text-amber-500" /> : <span className={`size-2 rounded-full ${providers.length ? 'bg-emerald-500' : 'bg-amber-500'}`} />}
          </button>
          <button className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-2.5 py-2 text-left transition hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900" onClick={() => openOptions('memory')}>
            <Brain className="size-4 shrink-0 text-zinc-400" />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium">Memory</div>
              <div className="truncate text-[10.5px] text-zinc-500">{stats ? `${stats.facts} facts · ${stats.history} learned` : '…'}</div>
            </div>
          </button>
        </div>

        {host && (
          <div className="flex items-center gap-2.5 rounded-xl px-1 py-0.5">
            <Globe className="size-4 text-zinc-400" />
            <div className="min-w-0 flex-1 truncate text-[12px] text-zinc-600 dark:text-zinc-400">{blocked ? `Off on ${host}` : `On for ${host}`}</div>
            <Switch
              checked={!blocked}
              disabled={!settings.behavior.enabled}
              onCheckedChange={(on) => {
                track('toolbar_action', { action: 'toggle_site' });
                update((d) => {
                  const list = d.behavior.blockedSites.filter((p) => !hostMatches(host, p));
                  d.behavior.blockedSites = on ? list : [...list, host];
                });
              }}
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-1 border-t border-zinc-200/70 bg-white px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
        <button className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800" onClick={() => openOptions()}>
          <Settings2 className="size-3.5" /> Settings
        </button>
        <button className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800" onClick={() => openOptions('logs')}>
          <ScrollText className="size-3.5" /> Logs
        </button>
        <a
          href={`mailto:${AUTHOR.email}`}
          target="_blank"
          rel="noreferrer"
          onClick={() => track('toolbar_action', { action: 'email' })}
          title={`Made by ${AUTHOR.name} · ${AUTHOR.email}`}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          <Mail className="size-3.5" /> Feedback
        </a>
        <button className="ml-auto pr-1.5 text-[10.5px] text-zinc-400 hover:text-zinc-600" onClick={() => openOptions('about')} title="About FormPilot">
          v{chrome.runtime.getManifest().version}
        </button>
      </div>
    </div>
  );
}
