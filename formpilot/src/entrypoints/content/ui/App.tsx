import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
import {
  Sparkles,
  X,
  Settings2,
  RefreshCw,
  Minimize2,
  Maximize2,
  WandSparkles,
  UserRound,
  History,
  CornerDownLeft,
  AlertTriangle,
  ListChecks,
  PauseCircle,
  Zap,
  Info,
  BookmarkPlus,
  Lock,
} from 'lucide-react';
import type { Suggestion } from '@/lib/types';
import { useStore, visibleItems, type Store } from '../store';

export interface Actions {
  insert(s: Suggestion): void;
  regenerate(): void;
  adjust(kind: 'shorter' | 'longer' | 'formal' | 'casual'): void;
  refine(text: string): void;
  toggleRefine(open?: boolean): void;
  close(): void;
  openFromIcon(): void;
  openSettings(section?: string): void;
  fillForm(): void;
  pauseSite(): void;
  setActive(i: number): void;
  generate(): void;
  remember(): void;
}

const SRC_ICON = { fact: UserRound, history: History, ai: Sparkles, cache: Zap } as const;
const SRC_LABEL = { fact: 'Memory', history: 'History', ai: 'AI', cache: 'Cached' } as const;

function usePosition(anchor: HTMLElement | null, el: HTMLElement | null, maxWidth: number, enabled: boolean) {
  useLayoutEffect(() => {
    if (!anchor || !el || !enabled) return;
    const update = () =>
      computePosition(anchor, el, {
        strategy: 'fixed',
        placement: 'bottom-start',
        middleware: [
          offset(6),
          flip({ padding: 8, fallbackPlacements: ['top-start', 'bottom-end', 'top-end'] }),
          shift({ padding: 8 }),
          size({
            padding: 8,
            apply({ availableHeight, availableWidth, rects }) {
              const w = Math.min(Math.max(rects.reference.width, 320), maxWidth, availableWidth);
              Object.assign(el.style, { width: `${w}px`, maxHeight: `${Math.max(180, Math.min(availableHeight, 520))}px` });
            },
          }),
        ],
      }).then(({ x, y }) => {
        el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      });
    return autoUpdate(anchor, el, update, { animationFrame: false });
  }, [anchor, el, maxWidth, enabled]);
}

function FieldIcon({ store, actions }: { store: Store; actions: Actions }) {
  const anchor = useStore(store, (s) => s.anchor);
  const visible = useStore(store, (s) => s.iconVisible && !s.open);
  const busy = useStore(store, (s) => ['retrieving', 'generating', 'streaming'].includes(s.status) || s.filling);
  const ref = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el || !visible) return;
    const update = () => {
      const r = anchor.getBoundingClientRect();
      const isArea = anchor.tagName === 'TEXTAREA' || anchor.isContentEditable;
      const top = isArea ? r.top + 6 : r.top + (r.height - 24) / 2;
      const left = r.right - 24 - (isArea ? 8 : 6) - (anchor.scrollHeight > anchor.clientHeight + 2 ? 12 : 0);
      const hidden = r.width === 0 || r.bottom < 0 || r.top > innerHeight;
      el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
      el.style.visibility = hidden ? 'hidden' : 'visible';
    };
    return autoUpdate(anchor, el, update);
  }, [anchor, visible]);

  if (!visible || !anchor) return null;
  return (
    <button
      ref={ref}
      className="fp-icon"
      style={{ top: 0, left: 0 }}
      data-busy={busy}
      title="FormPilot: AI suggestions (Alt+J)"
      aria-label="Show FormPilot suggestions"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => actions.openFromIcon()}
    >
      <Sparkles size={14} strokeWidth={2.4} />
    </button>
  );
}

function Skeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="fp-skel" aria-hidden>
      <div className="fp-skel-box" style={{ width: 26, height: 26 }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 2 }}>
        <div className="fp-skel-box" style={{ width: '30%', height: 9 }} />
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className="fp-skel-box" style={{ width: i === lines - 1 ? '65%' : '95%', height: 10 }} />
        ))}
      </div>
    </div>
  );
}

function Item({ s, index, active, streaming, actions }: { s: Suggestion; index: number; active: boolean; streaming: boolean; actions: Actions }) {
  const Icon = SRC_ICON[s.source];
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <button
      ref={ref}
      role="option"
      aria-selected={active}
      className="fp-item"
      onMouseEnter={() => actions.setActive(index)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => actions.insert(s)}
    >
      <span className="fp-src" data-src={s.source}>
        <Icon size={14} strokeWidth={2.2} />
      </span>
      <span className="fp-body">
        <span className="fp-meta">
          <span>{s.title || SRC_LABEL[s.source]}</span>
          {s.title && <span className="fp-badge">{SRC_LABEL[s.source]}</span>}
          {s.text.length > 140 && <span style={{ marginLeft: 'auto' }}>{s.text.length} chars</span>}
        </span>
        <span className="fp-text">
          {s.text}
          {streaming && <span className="fp-caret" />}
        </span>
      </span>
      <span className="fp-kbd fp-enter">
        <CornerDownLeft size={10} />
      </span>
    </button>
  );
}

function Panel({ store, actions }: { store: Store; actions: Actions }) {
  const st = useStore(store, (s) => s);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const refineRef = useRef<HTMLInputElement>(null);
  usePosition(st.anchor, el, st.maxWidth, st.open);

  useEffect(() => {
    if (st.refineOpen) refineRef.current?.focus();
  }, [st.refineOpen]);

  if (!st.open || !st.anchor || !st.field) return null;
  const items = visibleItems(st);
  const busy = st.status === 'retrieving' || st.status === 'generating' || st.status === 'streaming';
  const aiStart = st.instant.filter((x) => items.includes(x)).length;
  const q = st.field.label || st.field.placeholder || st.field.name || 'this field';
  const showSkeleton = (st.status === 'retrieving' || st.status === 'generating') && st.ai.length === 0;

  return (
    <div
      ref={setEl}
      className="fp-panel"
      role="listbox"
      aria-label="FormPilot suggestions"
      onMouseDown={(e) => {
        // Keep focus in the page field unless the user is clicking our refine box.
        if (!(e.target as HTMLElement).closest('input')) e.preventDefault();
      }}
    >
      <div className="fp-head">
        <span className="fp-brand">
          <Sparkles size={12} strokeWidth={2.6} />
        </span>
        <span className="fp-head-title">
          <span className="fp-head-name">FormPilot</span>
          <span className="fp-head-q" title={q}>
            {q}
          </span>
        </span>
        <button className="fp-iconbtn" title="Fill the whole form (Alt+Shift+J)" onClick={() => actions.fillForm()} disabled={st.filling}>
          <ListChecks size={15} />
        </button>
        <button className="fp-iconbtn" title="Pause FormPilot on this site" onClick={() => actions.pauseSite()}>
          <PauseCircle size={15} />
        </button>
        <button className="fp-iconbtn" title="Settings" onClick={() => actions.openSettings()}>
          <Settings2 size={15} />
        </button>
        <button className="fp-iconbtn" title="Close (Esc)" onClick={() => actions.close()}>
          <X size={15} />
        </button>
      </div>

      <div className="fp-list">
        {items.length > 0 && aiStart > 0 && <div className="fp-group">From your memory</div>}
        {items.map((s, i) => (
          <div key={s.id} style={{ display: 'contents' }}>
            {i === aiStart && aiStart > 0 && st.ai.length > 0 && <div className="fp-group">AI suggestions</div>}
            <Item s={s} index={i} active={i === st.active} streaming={st.status === 'streaming' && i === items.length - 1 && s.source === 'ai'} actions={actions} />
          </div>
        ))}
        {showSkeleton && (
          <>
            <Skeleton lines={st.field.longForm ? 3 : 1} />
            {st.field.longForm && <Skeleton lines={2} />}
          </>
        )}

        {!st.hasProvider && st.status !== 'error' && (
          <div className="fp-notice">
            <Info size={16} />
            <div>
              <strong>Connect a free AI provider</strong>
              Add a free Gemini, Groq or OpenRouter key, or enable Chrome's on-device AI.
              <div className="fp-notice-actions">
                <button className="fp-chip" data-primary="true" onClick={() => actions.openSettings('providers')}>
                  Open settings
                </button>
              </div>
            </div>
          </div>
        )}

        {st.status === 'error' && st.error && (
          <div className="fp-notice" data-tone="error" role="alert">
            <AlertTriangle size={16} />
            <div style={{ minWidth: 0 }}>
              <strong>{st.error.provider ? `${st.error.provider}: ` : ''}{errorTitle(st.error.code)}</strong>
              <span style={{ wordBreak: 'break-word' }}>{st.error.message}</span>
              {st.error.hint && <div style={{ marginTop: 4, opacity: 0.9 }}>{st.error.hint}</div>}
              <div className="fp-notice-actions">
                <button className="fp-chip" onClick={() => actions.regenerate()}>
                  <RefreshCw size={12} /> Retry
                </button>
                {st.error.code === 'locked' ? (
                  <button className="fp-chip" data-primary="true" onClick={() => actions.openSettings('providers?unlock=1')}>
                    <Lock size={12} /> Unlock
                  </button>
                ) : (
                  <button className="fp-chip" onClick={() => actions.openSettings(st.error?.code === 'auth' || st.error?.code === 'no-provider' ? 'providers' : 'logs')}>
                    {st.error.code === 'auth' || st.error.code === 'no-provider' ? 'Fix in settings' : 'View logs'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {st.status === 'done' && items.length === 0 && (
          <div className="fp-notice">
            <Info size={16} />
            <div>
              <strong>No suggestion</strong>
              {st.meta?.note ?? 'Nothing relevant found in your memory.'}
              <div className="fp-notice-actions">
                <button className="fp-chip" onClick={() => actions.openSettings('memory')}>
                  Add to memory
                </button>
              </div>
            </div>
          </div>
        )}

        {st.status === 'instant' && items.length > 0 && st.hasProvider && (
          <button className="fp-item" onMouseDown={(e) => e.preventDefault()} onClick={() => actions.generate()}>
            <span className="fp-src" data-src="ai">
              <WandSparkles size={14} />
            </span>
            <span className="fp-body">
              <span className="fp-meta">Generate with AI</span>
              <span className="fp-text" style={{ color: 'var(--fp-muted)' }}>
                Write new options from your memory and the page
              </span>
            </span>
          </button>
        )}
        {st.status === 'idle' && items.length === 0 && st.hasProvider && (
          <button className="fp-item" aria-selected onMouseDown={(e) => e.preventDefault()} onClick={() => actions.generate()}>
            <span className="fp-src" data-src="ai">
              <WandSparkles size={14} />
            </span>
            <span className="fp-body">
              <span className="fp-meta">Generate with AI</span>
              <span className="fp-text">Press Enter to write suggestions for this field</span>
            </span>
          </button>
        )}
      </div>

      {st.refineOpen && (
        <form
          className="fp-refine"
          onSubmit={(e) => {
            e.preventDefault();
            const v = refineRef.current?.value.trim();
            if (v) actions.refine(v);
          }}
        >
          <input
            ref={refineRef}
            placeholder="e.g. mention my React experience, keep it under 50 words"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') actions.toggleRefine(false);
            }}
          />
          <button className="fp-chip" data-primary="true" type="submit">
            Rewrite
          </button>
        </form>
      )}

      {st.hasProvider && (
        <div className="fp-actions">
          <button className="fp-chip" onClick={() => actions.regenerate()} disabled={busy}>
            <RefreshCw size={12} /> {st.ai.length ? 'Regenerate' : 'Generate'}
          </button>
          <button className="fp-chip" onClick={() => actions.adjust('shorter')} disabled={busy || !st.ai.length}>
            <Minimize2 size={12} /> Shorter
          </button>
          <button className="fp-chip" onClick={() => actions.adjust('longer')} disabled={busy || !st.ai.length}>
            <Maximize2 size={12} /> Longer
          </button>
          <button className="fp-chip" onClick={() => actions.toggleRefine()} disabled={busy} data-primary={st.refineOpen}>
            <WandSparkles size={12} /> Refine…
          </button>
          {st.field.currentValue.trim() && (
            <button className="fp-chip" onClick={() => actions.remember()} title="Save what's in the field now as the correct answer for this question">
              <BookmarkPlus size={12} /> Save my answer
            </button>
          )}
        </div>
      )}

      <div className="fp-foot">
        <span className="fp-foot-keys">
          <span>
            <span className="fp-kbd">↑↓</span>
          </span>
          <span>
            <span className="fp-kbd">⏎</span> insert
          </span>
          <span>
            <span className="fp-kbd">esc</span>
          </span>
        </span>
        <span className="fp-foot-right" title={st.meta?.memoryHits?.map((h) => h.doc).join(', ')}>
          <span className="fp-dot" data-busy={busy} data-err={st.status === 'error'} />
          {busy
            ? st.status === 'retrieving'
              ? 'Searching memory…'
              : `${st.providerLabel ?? 'AI'} is writing…`
            : st.meta?.provider
              ? `${st.meta.cached ? 'Cached · ' : ''}${st.meta.provider}${st.meta.ms ? ` · ${st.meta.ms < 1000 ? `${st.meta.ms}ms` : `${(st.meta.ms / 1000).toFixed(1)}s`}` : ''}${st.meta.memoryHits?.length ? ` · ${st.meta.memoryHits.length} doc${st.meta.memoryHits.length > 1 ? 's' : ''}` : ''}`
              : st.meta?.note ?? 'Ready'}
        </span>
      </div>
    </div>
  );
}

function errorTitle(code: string): string {
  switch (code) {
    case 'auth':
      return 'Invalid or missing API key';
    case 'rate-limit':
      return 'Rate limit reached';
    case 'network':
      return 'Network error';
    case 'timeout':
      return 'Timed out';
    case 'no-provider':
      return 'No AI provider';
    case 'cors':
      return 'Connection blocked';
    case 'blocked':
      return 'Not allowed';
    case 'unavailable':
      return 'Provider unavailable';
    case 'locked':
      return 'Locked';
    default:
      return 'Something went wrong';
  }
}

function ToastView({ store }: { store: Store }) {
  const t = useStore(store, (s) => s.toast);
  if (!t) return null;
  return (
    <div className="fp-toast" data-tone={t.tone} role="status">
      <span>{t.text}</span>
      {t.actions?.map((a) => (
        <button key={a.label} data-primary={a.primary} onClick={a.run}>
          {a.label}
        </button>
      ))}
    </div>
  );
}

const ACCENTS: Record<string, string> = {
  violet: '#7c3aed',
  blue: '#2563eb',
  emerald: '#059669',
  orange: '#ea580c',
  rose: '#e11d48',
  slate: '#475569',
};

export function App({ store, actions }: { store: Store; actions: Actions }) {
  const theme = useStore(store, (s) => s.theme);
  const accent = useStore(store, (s) => s.accent);
  const compact = useStore(store, (s) => s.compact);
  const reduce = useStore(store, (s) => s.reduceMotion);
  return (
    <div
      className={`fp${compact ? ' fp-compact' : ''}`}
      data-theme={theme}
      data-motion={reduce ? 'reduce' : 'full'}
      style={{ ['--fp-accent' as string]: ACCENTS[accent] ?? accent }}
    >
      <FieldIcon store={store} actions={actions} />
      <Panel store={store} actions={actions} />
      <ToastView store={store} />
    </div>
  );
}
