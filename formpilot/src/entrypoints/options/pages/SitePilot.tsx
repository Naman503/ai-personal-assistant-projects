import { useEffect, useMemo, useState } from 'react';
import { Activity, Building2, Cpu, FastForward, Pause, FileText, History, ListChecks, Play, Square, Upload } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Input, PageHeader, Row, Segmented, Switch, Textarea } from '@/components/ui';
import { rpc } from '@/lib/messages';
import { ATS, ATS_NAME, type Ats } from '@/lib/sitepilot/detect';
import { spDb, type SpJob, type SpShot, type SpStatus } from '@/lib/sitepilot/db';
import { learnedBoards, type SpState } from '@/lib/sitepilot/runner';
import type { PageProps } from '../App';
import { PilotAiCard, PilotAiReport } from './PilotAi';

const BRIEF_EXAMPLE = `You apply for jobs on my behalf. I am a software engineer looking for my next role.

About me: [years] years of experience. Primary stack: [e.g. React Native, React, TypeScript, Node.js]. Also: [other real skills]. Current company: [company], since [month year]. Based in [city]; open to [cities / remote].

What I want: [titles]. Expected CTC [amount], current CTC [amount], notice period [days].

How to answer:
- Be accurate. Only claim skills, years and projects that are in my resume or facts.
- Short, specific free-text answers in first person, based on real work from my resume.
- Willing to relocate, work on-site or hybrid: yes. Visa sponsorship: not needed.
- Demographic questions: decline to self-identify. Marketing / newsletter / job alerts: no.

Never: create accounts, type passwords, solve CAPTCHAs, take tests, or pay.`;

type Status = SpState & { counts: Record<SpStatus, number> };
const time = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

const TABS: { id: string; label: string; statuses: SpStatus[] }[] = [
  { id: 'queue', label: 'Queue', statuses: ['queued', 'working'] },
  { id: 'needs', label: 'Needs you', statuses: ['needs-you', 'unsure'] },
  { id: 'ready', label: 'Ready (dry run)', statuses: ['ready'] },
  { id: 'sent', label: 'Sent', statuses: ['sent'] },
  { id: 'other', label: 'Skipped / failed', statuses: ['skipped', 'failed'] },
];
const TONE: Record<SpStatus, 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'brand'> = { queued: 'neutral', working: 'blue', sent: 'green', ready: 'brand', 'needs-you': 'amber', unsure: 'amber', skipped: 'neutral', failed: 'red' };

function useSitePilot(every = 2000) {
  const [st, setSt] = useState<Status | null>(null);
  const call = (action: 'start' | 'stop' | 'status' | 'run-now' | 'pause' | 'resume') => rpc<Status>({ type: 'sp', action }).then(setSt).catch(() => {});
  useEffect(() => {
    void call('status');
    const t = setInterval(() => void call('status'), every);
    return () => clearInterval(t);
  }, [every]);
  return { st, call };
}

function useJobs(statuses: SpStatus[], version: unknown) {
  const [jobs, setJobs] = useState<SpJob[]>([]);
  const key = statuses.join(',');
  useEffect(() => {
    let live = true;
    void spDb()
      .jobs.where('status')
      .anyOf(statuses)
      .toArray()
      .then((j) => live && setJobs(j.sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt)).slice(0, 300)));
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
  return jobs;
}

function JobRow({ job, onChange }: { job: SpJob; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [shots, setShots] = useState<SpShot[]>([]);
  const [big, setBig] = useState<string | null>(null);
  useEffect(() => {
    if (open) void spDb().shots.where('jobId').equals(job.id).sortBy('at').then(setShots);
  }, [open, job.id, job.shots.length]);
  const requeue = async () => {
    await spDb().jobs.update(job.id, { status: 'queued', reason: '', updatedAt: Date.now() });
    onChange();
  };
  const remove = async () => {
    await spDb().shots.where('jobId').equals(job.id).delete();
    await spDb().jobs.delete(job.id);
    onChange();
  };
  const link = job.applyUrl || job.url;
  return (
    <div className="border-b border-zinc-100 px-4 py-2.5 text-sm last:border-0 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <button className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => setOpen(!open)}>
          {job.title || link}
          {job.company ? <span className="font-normal text-zinc-500"> · {job.company}</span> : null}
        </button>
        {job.ats ? <Badge tone="blue">{ATS_NAME[job.ats as Ats] ?? job.ats}</Badge> : null}
        <Badge tone={TONE[job.status]}>{job.status}</Badge>
        <span className="text-xs text-zinc-400 tabular-nums">{time(job.doneAt ?? job.addedAt)}</span>
      </div>
      {job.reason ? <div className="mt-0.5 text-xs text-zinc-500">{job.reason}</div> : null}
      {open ? (
        <div className="mt-2 space-y-3">
          <div className="flex flex-wrap gap-2">
            <a className="text-xs text-brand underline" href={link} target="_blank" rel="noreferrer">
              Open the form
            </a>
            {job.via && job.via !== link ? (
              <a className="text-xs text-brand underline" href={job.via} target="_blank" rel="noreferrer">
                Job on Naukri
              </a>
            ) : null}
            {job.status !== 'queued' && job.status !== 'working' && job.status !== 'sent' ? (
              <Button size="sm" onClick={() => void requeue()}>
                Try again
              </Button>
            ) : null}
            {job.status !== 'working' ? (
              <Button size="sm" variant="ghost" onClick={() => void remove()}>
                Remove
              </Button>
            ) : null}
          </div>
          {shots.length ? (
            <div className="flex flex-wrap gap-2">
              {shots.map((s) => (
                <button key={s.id} onClick={() => setBig(s.data)} className="text-center">
                  <img src={s.data} alt={s.kind} className="h-24 rounded border border-zinc-200 object-cover object-top dark:border-zinc-700" />
                  <div className="text-[10px] text-zinc-500">{s.kind}</div>
                </button>
              ))}
            </div>
          ) : null}
          {big ? (
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6" onClick={() => setBig(null)}>
              <img src={big} alt="screenshot" className="max-h-full max-w-full rounded shadow-2xl" />
            </div>
          ) : null}
          {job.answers.length ? (
            <div>
              <div className="mb-1 text-xs font-semibold text-zinc-500">Answers</div>
              <div className="max-h-64 overflow-auto rounded-lg border border-zinc-200 text-xs dark:border-zinc-800">
                {job.answers.map((a, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 border-b border-zinc-100 px-2 py-1 last:border-0 dark:border-zinc-800">
                    <span className="text-zinc-600 dark:text-zinc-400">{a.q}</span>
                    <span>{a.a}</span>
                    <span className="text-zinc-400">{a.src ?? ''}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <div className="mb-1 text-xs font-semibold text-zinc-500">Steps</div>
            <div className="max-h-48 overflow-auto text-xs">
              {job.steps.map((s, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 text-zinc-400 tabular-nums">{clock(s.t)}</span>
                  <span>{s.what}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ResumeFile() {
  const [f, setF] = useState<{ name: string; size: number; updatedAt: number } | null>(null);
  const load = () => void spDb().files.get('resume').then((x) => setF(x ? { name: x.name, size: x.size, updatedAt: x.updatedAt } : null));
  useEffect(load, []);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    await spDb().files.put({ key: 'resume', name: file.name, type: file.type || 'application/pdf', size: file.size, data: await file.arrayBuffer(), updatedAt: Date.now() });
    load();
  };
  return (
    <Row label="Resume file" description={f ? `${f.name} · ${Math.round(f.size / 1024)} KB · saved ${time(f.updatedAt)}. Uploaded to resume fields only (never into cover letter or other file fields).` : 'Not set yet: forms with a required resume will be left for you until you add it.'}>
      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
        <Upload className="size-4" /> {f ? 'Replace' : 'Choose PDF'}
        <input type="file" accept=".pdf,.doc,.docx" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
      </label>
    </Row>
  );
}

export function SitePilot({ settings, update }: PageProps) {
  const sp = settings.sitePilot;
  const la = settings.localAi;
  const { st, call } = useSitePilot();
  const [tab, setTab] = useState('queue');
  const [paste, setPaste] = useState('');
  const [added, setAdded] = useState('');
  const [model, setModel] = useState(sp.model);
  const [light, setLight] = useState(la.lightModel);
  const [link, setLink] = useState(sp.resumeLink);
  const [boards, setBoards] = useState(sp.boards);
  const [brief, setBrief] = useState(sp.brief);
  const [stack, setStack] = useState(sp.stack);
  const [learned, setLearned] = useState<string[]>([]);
  useEffect(() => void learnedBoards().then(setLearned).catch(() => {}), []);
  const [installed, setInstalled] = useState<string[]>([]);
  const version = useMemo(() => JSON.stringify([st?.counts, st?.cur?.jobId, st?.message]), [st]);
  const [bump, setBump] = useState(0);
  const jobs = useJobs(TABS.find((t) => t.id === tab)!.statuses, `${version}${bump}`);
  const set = <K extends keyof typeof sp>(k: K, v: (typeof sp)[K]) => update((d) => void (d.sitePilot[k] = v));
  const setL = <K extends keyof typeof la>(k: K, v: (typeof la)[K]) => update((d) => void (d.localAi[k] = v));

  useEffect(() => {
    void fetch(`${sp.baseUrl.replace(/\/+$/, '')}/api/tags`)
      .then((r) => r.json())
      .then((j: { models?: { name: string }[] }) => setInstalled((j.models ?? []).map((m) => m.name)))
      .catch(() => setInstalled([]));
  }, [sp.baseUrl]);

  const addPasted = async () => {
    const urls = [...new Set(paste.match(/https?:\/\/[^\s"'<>]+/g) ?? [])];
    if (!urls.length) return setAdded('No links found.');
    const r = await rpc<{ added: number; known: number }>({ type: 'sp-add', jobs: urls.map((url) => ({ url, source: 'manual' as const })) }).catch(() => null);
    setAdded(r ? `${r.added} added${r.known ? `, ${r.known} already known` : ''}.` : 'Could not add.');
    if (r?.added) setPaste('');
    setBump((n) => n + 1);
  };

  const c = st?.counts;
  const live = sp.liveAts;
  const phase = !st?.running ? 'Off' : st.paused ? 'Paused' : st.phase === 'working' ? 'Working' : st.phase === 'pause' ? 'Pause between jobs' : st.phase === 'waiting' ? 'Waiting for you to be away' : 'Idle (queue empty)';

  return (
    <>
      <PageHeader
        title="Site Pilot"
        description="Applies on company career sites and Google Forms in its own Brave window. Separate from the Autopilot; both can run at once. No daily limit."
        actions={
          st?.running ? (
            <div className="flex gap-2">
              {st.paused ? (
                <Button variant="primary" onClick={() => void call('resume')}>
                  <Play className="size-4" /> Resume
                </Button>
              ) : (
                <>
                  <Button onClick={() => void call('pause')} title="Stop now and keep the queue; Resume carries on">
                    <Pause className="size-4" /> Pause
                  </Button>
                  <Button onClick={() => void call('run-now')} disabled={!!st.cur} title="Skip the pause and start the next job">
                    <FastForward className="size-4" /> Next job now
                  </Button>
                </>
              )}
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
            <Badge tone={st?.running ? 'green' : 'neutral'}>{phase}</Badge>
            <Badge tone={live.length ? 'red' : 'amber'}>{live.length ? `Live on ${live.map((a) => ATS_NAME[a as Ats] ?? a).join(', ')}` : 'Dry run everywhere'}</Badge>
            <span className="text-sm">{st?.message}</span>
          </div>
          {st?.waiting ? <div className="text-xs text-amber-600">Local model: {st.waiting}</div> : null}
          {st?.nextAt && st.running && !st.cur ? <div className="text-xs text-zinc-500">Next: {clock(st.nextAt)}</div> : null}
          {c ? (
            <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
              {(
                [
                  ['Queue', c.queued + c.working],
                  ['Sent', c.sent],
                  ['Ready (dry)', c.ready],
                  ['Needs you', c['needs-you'] + c.unsure],
                  ['Skipped', c.skipped],
                  ['Failed', c.failed],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="rounded-xl border border-zinc-200 p-2 dark:border-zinc-800">
                  <div className="text-lg font-semibold">{v}</div>
                  <div className="text-[11px] text-zinc-500">{k}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<ListChecks className="size-4" />} title="Applications" />
        <div className="flex flex-wrap gap-1 px-4 pt-3">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`rounded-lg px-2.5 py-1 text-xs font-medium ${tab === t.id ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'}`}>
              {t.label} ({t.statuses.reduce((n, s) => n + (c?.[s] ?? 0), 0)})
            </button>
          ))}
        </div>
        {tab === 'ready' && jobs.length ? (
          <div className="flex flex-wrap items-center gap-2 px-4 pt-2 text-xs text-zinc-500">
            <Button
              size="sm"
              disabled={!live.length}
              onClick={async () => {
                const ids = jobs.filter((j) => j.ats && (live.includes(j.ats) || (live.includes('other') && !(ATS as readonly string[]).includes(j.ats)))).map((j) => j.id);
                await spDb().jobs.where('id').anyOf(ids).modify((j) => {
                  j.status = 'queued';
                  j.reason = 'sending for real';
                  j.dry = false;
                  j.updatedAt = Date.now();
                });
                setBump((n) => n + 1);
                if (st?.running) void call('run-now');
              }}
            >
              Send these for real
            </Button>
            {live.length ? `Fills each one again and presses Submit on the systems ticked under “Really submit on” (${live.map((a) => ATS_NAME[a as Ats] ?? a).join(', ')}).` : 'Tick systems under “Really submit on” first.'}
          </div>
        ) : null}
        <div className="mt-2 max-h-[560px] overflow-auto">
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} onChange={() => setBump((n) => n + 1)} />
          ))}
          {!jobs.length ? <div className="px-4 py-6 text-center text-sm text-zinc-500">Nothing here.</div> : null}
        </div>
        <div className="border-t border-zinc-100 p-4 dark:border-zinc-800">
          <div className="mb-1 text-sm font-medium">Add links</div>
          <div className="mb-2 text-xs text-zinc-500">Company application pages, Google Forms, or Naukri jobs that apply on the company site. One or many, any format. Also: the popup's “Apply with Site Pilot” on any page.</div>
          <Textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="https://jobs.lever.co/…  https://forms.gle/…" />
          <div className="mt-2 flex items-center gap-3">
            <Button size="sm" onClick={() => void addPasted()}>
              Add to queue
            </Button>
            <span className="text-xs text-zinc-500">{added}</span>
          </div>
        </div>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<Building2 className="size-4" />} title="Applying" />
        <ResumeFile />
        <Row label="Brief for the model" description="Always sent to the local model first: who it works for, what you want, how to answer, what never to do. Write it like instructions to an assistant applying for you. Your facts and resume are added on their own." stacked>
          <Textarea rows={10} value={brief} placeholder={BRIEF_EXAMPLE} onChange={(e) => setBrief(e.target.value)} onBlur={() => set('brief', brief)} />
          <div className="mt-1 flex gap-2">
            {!brief.trim() ? (
              <Button size="sm" onClick={() => (setBrief(BRIEF_EXAMPLE), set('brief', BRIEF_EXAMPLE))}>
                Start from the example
              </Button>
            ) : null}
            <span className="text-xs text-zinc-500">{brief.length}/6000</span>
          </div>
        </Row>
        <Row label="How to answer skill questions" description="Truthful: years and “have you worked with X” come only from your resume and memory (0 / No when they don't mention it). Keep in the running: 3 years / Yes when memory doesn't say, like the Autopilot. Willingness questions (relocate, on-site, shifts) are Yes either way.">
          <Segmented value={sp.answerStyle} onChange={(v) => set('answerStyle', v as typeof sp.answerStyle)} options={[{ value: 'truthful', label: 'Truthful' }, { value: 'keep-in', label: 'Keep in the running' }]} />
        </Row>
        <Row label="Resume link" description="For forms that ask for a link to your resume (Google Drive / Dropbox, viewable by anyone with the link). Empty: such forms are left for you.">
          <Input className="w-72" placeholder="https://drive.google.com/…" value={link} onChange={(e) => setLink(e.target.value)} onBlur={() => set('resumeLink', link.trim())} />
        </Row>
        <Row label="Really submit on" description="Ticked systems get Submit pressed (once the form is complete and the model agrees). Unticked: dry run, it fills and checks everything, then stops before Submit and files it under “Ready”.">
          <div className="flex max-w-md flex-wrap justify-end gap-x-3 gap-y-1 text-sm">
            {ATS.map((a) => (
              <label key={a} className="flex items-center gap-1">
                <input type="checkbox" checked={live.includes(a)} onChange={(e) => set('liveAts', e.target.checked ? [...live, a] : live.filter((x) => x !== a))} />
                {ATS_NAME[a]}
              </label>
            ))}
          </div>
        </Row>
        <Row label="Look at the page (screenshots)" description="The model sees each page before Submit and fixes what the normal fill missed. Slower, but it's what makes unknown sites work.">
          <Switch checked={sp.vision} onCheckedChange={(v) => set('vision', v)} />
        </Row>
        <Row label="Read company job boards" description="When the queue is empty (every 4 hours at most), reads the public job boards companies publish on Greenhouse, Lever, Ashby, Workable, Recruitee and SmartRecruiters, and queues jobs that fit your titles and level, in India or remote and open to India.">
          <Switch checked={sp.harvestBoards} onCheckedChange={(v) => set('harvestBoards', v)} />
        </Row>
        <Row label="Read remote job boards" description="Also reads Himalayas (only jobs open to India), Remotive, Remote OK and We Work Remotely for your titles, keeps remote jobs open to India, and follows each job's Apply link to the company's own form.">
          <Switch checked={sp.remoteBoards} onCheckedChange={(v) => set('remoteBoards', v)} />
        </Row>
        <Row label="Job boards" description={`"system:company", comma separated. Boards Site Pilot meets on the way are added by itself${learned.length ? ` (learned so far: ${learned.join(', ')})` : ''}. Posted within ${sp.boardDays} days.`} stacked>
          <Textarea rows={3} value={boards} onChange={(e) => setBoards(e.target.value)} onBlur={() => set('boards', boards)} />
        </Row>
        <Row label="Your stack" description="Board jobs must name one of these in the title, or at least two in the description. Roles in other specialisms (security, infrastructure, data, Go, Java, iOS-only…) are left out." stacked>
          <Input value={stack} onChange={(e) => setStack(e.target.value)} onBlur={() => set('stack', stack)} />
        </Row>
        <Row label="Senior roles" description="Include Senior / Sr. roles from job boards. They usually ask for 5+ years.">
          <Switch checked={sp.seniorRoles} onCheckedChange={(v) => set('seniorRoles', v)} />
        </Row>
        <Row label="Find jobs on Naukri" description="When the queue is empty, searches Naukri for your Autopilot job titles (newest first) and queues the ones that apply on the company site.">
          <Switch checked={sp.harvestNaukri} onCheckedChange={(v) => set('harvestNaukri', v)} />
        </Row>
        <Row label="Take jobs from the Autopilot" description="Naukri jobs the Autopilot skips because they apply on the company site, and Google Forms a recruiter's chatbot asks for.">
          <Switch checked={sp.fromAutopilot} onCheckedChange={(v) => set('fromAutopilot', v)} />
        </Row>
        <Row label="Per company" description="At most this many applications to one company in 30 days.">
          <Input type="number" min={1} max={20} className="w-16" value={String(sp.perCompany)} onChange={(e) => set('perCompany', Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
        </Row>
        <Row label="Pause between jobs" description="Seconds, random in the range.">
          <div className="flex items-center gap-2 text-sm">
            <Input type="number" min={0} max={1800} className="w-20" value={String(sp.pauseMinSec)} onChange={(e) => set('pauseMinSec', Math.max(0, Number(e.target.value) || 0))} />–
            <Input type="number" min={0} max={1800} className="w-20" value={String(sp.pauseMaxSec)} onChange={(e) => set('pauseMaxSec', Math.max(0, Number(e.target.value) || 0))} /> s
          </div>
        </Row>
        <Row label="Limits per job" description="Then the job is left for you with a screenshot of where it stopped.">
          <div className="flex items-center gap-2 text-sm">
            <Input type="number" min={5} max={80} className="w-16" value={String(sp.maxActions)} onChange={(e) => set('maxActions', Math.max(5, Math.min(80, Number(e.target.value) || 30)))} /> actions ·
            <Input type="number" min={3} max={60} className="w-16" value={String(sp.maxMinutes)} onChange={(e) => set('maxMinutes', Math.max(3, Math.min(60, Number(e.target.value) || 15)))} /> min
          </div>
        </Row>
      </Card>

      <PilotAiCard who="sitePilot" settings={settings} update={update} />
      <PilotAiReport who="sitePilot" />

      <Card className="mb-5">
        <CardHeader icon={<Cpu className="size-4" />} title="Local model" description="How the local model runs on this Mac. These settings apply to every local model call, by either pilot." />
        <Row label="Default local model" description={`Used when the AI card above leaves the local model empty. Installed: ${installed.join(', ') || 'Ollama not reachable'}. gemma4:12b scored 15/15 on real application questions and can read screenshots.`}>
          <Input className="w-48" value={model} onChange={(e) => setModel(e.target.value)} onBlur={() => set('model', model.trim() || 'gemma4:12b')} />
        </Row>
        <Row label="While you're using the Mac" description="Go slow: fewer model calls and the model is unloaded sooner. Pause: no new job starts until you've been away (a job in progress is finished slowly). The model always runs on the GPU: CPU-only took over 10 minutes per answer here.">
          <Segmented value={la.whenActive} onChange={(v) => setL('whenActive', v as typeof la.whenActive)} options={[{ value: 'slow', label: 'Go slow' }, { value: 'pause', label: 'Pause' }, { value: 'full', label: 'Full speed' }]} />
        </Row>
        <Row label="You count as away after" description="Minutes without keyboard or mouse input.">
          <div className="flex items-center gap-2 text-sm">
            <Input type="number" min={1} max={30} className="w-16" value={String(la.idleMinutes)} onChange={(e) => setL('idleMinutes', Math.max(1, Math.min(30, Number(e.target.value) || 3)))} /> min
          </div>
        </Row>
        <Row label="Model calls per minute" description="While you're active / while you're away. Spacing calls out keeps the GPU free between them.">
          <div className="flex items-center gap-2 text-sm">
            <Input type="number" min={1} max={30} className="w-16" value={String(la.rpmActive)} onChange={(e) => setL('rpmActive', Math.max(1, Math.min(30, Number(e.target.value) || 2)))} /> /
            <Input type="number" min={1} max={60} className="w-16" value={String(la.rpmIdle)} onChange={(e) => setL('rpmIdle', Math.max(1, Math.min(60, Number(e.target.value) || 6)))} />
          </div>
        </Row>
        <Row label="Keep the model loaded" description="Unloading frees about 8 GB of memory; loading again takes about 25 s.">
          <Segmented value={la.keepAlive} onChange={(v) => setL('keepAlive', v as typeof la.keepAlive)} options={[{ value: '0', label: 'Unload after each call' }, { value: '5m', label: '5 min' }, { value: '30m', label: '30 min' }]} />
        </Row>
        <Row label="Context size" description="Smaller uses less memory. 8k fits a whole form with your resume.">
          <Segmented value={String(la.numCtx)} onChange={(v) => setL('numCtx', Number(v))} options={[{ value: '4096', label: '4k' }, { value: '8192', label: '8k' }, { value: '16384', label: '16k' }]} />
        </Row>
        <Row label="Lighter model while you work" description={`Optional: used only while you're active (empty: always the main model).${installed.some((m) => m.startsWith('gemma4:e4b')) ? ' gemma4:e4b is installed.' : ''}`}>
          <Input className="w-48" placeholder="gemma4:e4b" value={light} onChange={(e) => setLight(e.target.value)} onBlur={() => setL('lightModel', light.trim())} />
        </Row>
      </Card>

      <Card className="mb-5">
        <CardHeader icon={<History className="size-4" />} title="What it did" />
        <div className="max-h-64 overflow-auto p-4 text-xs">
          {(st?.history ?? []).slice().reverse().map((h, i) => (
            <div key={i} className="flex gap-2 py-0.5">
              <span className="shrink-0 tabular-nums text-zinc-400">{clock(h.t)}</span>
              <span>{h.msg}</span>
            </div>
          ))}
          {!st?.history?.length ? (
            <div className="flex items-center gap-2 text-zinc-500">
              <FileText className="size-4" /> Nothing yet.
            </div>
          ) : null}
        </div>
      </Card>
    </>
  );
}
