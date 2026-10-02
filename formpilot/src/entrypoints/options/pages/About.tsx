import { useState } from 'react';
import { toast } from 'sonner';
import { Bug, Check, Code2, Copy, ExternalLink, Heart, Mail, MessageSquareText, ShieldCheck, Sparkles, Zap, Brain } from 'lucide-react';
import { Badge, Button, Card } from '@/components/ui';
import { AUTHOR, feedbackMailto } from '@/lib/about';
import type { PageProps } from '../App';

const STACK = ['WXT (MV3)', 'React 19', 'TypeScript', 'Tailwind CSS v4', 'Radix UI', 'Floating UI', 'Dexie', 'MiniSearch', 'pdf.js', 'Vitest', 'Playwright'];

export function Avatar({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const s = size === 'lg' ? 'size-20 text-2xl rounded-3xl' : size === 'md' ? 'size-9 text-[13px] rounded-xl' : 'size-6 text-[10px] rounded-lg';
  return (
    <div className={`${s} grid shrink-0 place-items-center bg-gradient-to-br from-brand via-fuchsia-500 to-amber-400 font-semibold tracking-tight text-white shadow-md shadow-brand/25`}>
      {AUTHOR.initials}
    </div>
  );
}

export function About(_: PageProps) {
  const [copied, setCopied] = useState(false);
  const version = chrome.runtime.getManifest().version;

  const copy = async () => {
    await navigator.clipboard.writeText(AUTHOR.email);
    setCopied(true);
    toast.success('Email copied');
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <>
      {/* Hero */}
      <Card className="relative mb-6 overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-r from-brand/90 via-fuchsia-500/80 to-amber-400/70" />
        <div className="pointer-events-none absolute -top-10 right-10 size-40 rounded-full bg-white/20 blur-2xl" />
        <div className="relative px-6 pt-14 pb-6">
          <div className="grid size-16 place-items-center rounded-2xl bg-white text-brand shadow-xl ring-4 ring-white dark:bg-zinc-900 dark:ring-zinc-900">
            <Sparkles className="size-8" />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">FormPilot</h1>
            <Badge tone="brand">v{version}</Badge>
          </div>
          <p className="mt-1 max-w-xl text-sm text-zinc-500 dark:text-zinc-400">
            AI form filling grounded in your own documents. Suggestions appear right under the field, like a password manager, and get faster every time you use them.
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {[
              { icon: Brain, title: 'Your memory', text: 'Answers come from your resume, notes and facts.' },
              { icon: Zap, title: 'Instant repeats', text: 'Known questions fill with no AI call.' },
              { icon: ShieldCheck, title: 'Private by design', text: 'Sensitive fields are never touched.' },
            ].map((f) => (
              <div key={f.title} className="rounded-xl border border-zinc-200/80 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-800/30">
                <f.icon className="size-4 text-brand" />
                <div className="mt-2 text-[13px] font-medium">{f.title}</div>
                <div className="text-xs text-zinc-500">{f.text}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Developer */}
      <Card className="mb-6 p-6">
        <div className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Developer</div>
        <div className="mt-4 flex flex-wrap items-center gap-5">
          <Avatar size="lg" />
          <div className="min-w-0 flex-1">
            <div className="text-xl font-semibold tracking-tight">{AUTHOR.name}</div>
            <div className="text-sm text-zinc-500">{AUTHOR.role} of FormPilot</div>
            <a href={`mailto:${AUTHOR.email}`} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-2.5 py-1 font-mono text-[13px] text-zinc-700 transition hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700">
              <Mail className="size-3.5 text-brand" /> {AUTHOR.email}
            </a>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="md" onClick={() => (location.href = `mailto:${AUTHOR.email}`)}>
              <Mail className="size-4" /> Email
            </Button>
            <Button size="md" onClick={copy}>
              {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />} {copied ? 'Copied' : 'Copy email'}
            </Button>
          </div>
        </div>
      </Card>

      {/* Support */}
      <div className="mb-6 grid gap-3 md:grid-cols-3">
        {[
          { icon: MessageSquareText, title: 'Send feedback', text: 'Ideas, feature requests or a quick hello.', href: feedbackMailto('feedback'), cta: 'Write an email' },
          { icon: Bug, title: 'Report a bug', text: 'Version and browser are filled in for you.', href: feedbackMailto('bug'), cta: 'Email a bug report' },
          { icon: Code2, title: 'Source code', text: 'Browse the code, open issues, contribute.', href: AUTHOR.repo, cta: 'Open on GitHub' },
        ].map((c) => (
          <a key={c.title} href={c.href} target={c.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className="group">
            <Card className="h-full p-5 transition group-hover:border-brand/40 group-hover:shadow-md group-hover:shadow-brand/5">
              <div className="grid size-9 place-items-center rounded-xl bg-brand/10 text-brand">
                <c.icon className="size-4" />
              </div>
              <div className="mt-3 text-sm font-semibold">{c.title}</div>
              <div className="mt-0.5 text-[13px] text-zinc-500">{c.text}</div>
              <div className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-brand">
                {c.cta} <ExternalLink className="size-3 transition group-hover:translate-x-0.5" />
              </div>
            </Card>
          </a>
        ))}
      </div>

      {/* Built with */}
      <Card className="p-5">
        <div className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Built with</div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {STACK.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      </Card>

      <p className="mt-8 flex items-center justify-center gap-1.5 text-xs text-zinc-400">
        Made with <Heart className="size-3.5 fill-rose-500 text-rose-500" /> by {AUTHOR.name}
      </p>
    </>
  );
}
