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
  Pin,
  PinOff,
  MoreHorizontal,
  GripVertical,
  LocateFixed,
} from 'lucide-react';
import type { Suggestion } from '@/lib/types';
import { useStore, visibleItems, type Store } from '../store';
import { resolvePos, toScreenPos, type SavedPos } from '@/lib/panel-position';

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
  savePosition(pos: SavedPos): void;
  resetPosition(): void;
  togglePin(): void;
}

const SRC_ICON = { fact: UserRound, history: History, ai: Sparkles, cache: Zap } as const;
const SRC_LABEL = { fact: 'Memory', history: 'History', ai: 'AI', cache: 'Cached' } as const;

const PLACEMENTS = { auto: 'bottom-start', below: 'bottom-start', above: 'top-start', right: 'right-start', left: 'left-start' } as const;

/** Anchored mode: Floating UI keeps the popup next to the field (flips/shifts to stay on screen). */
function usePosition(anchor: HTMLElement | null, el: HTMLElement | null, maxWidth: number, maxHeight: number, placement: keyof typeof PLACEMENTS, enabled: boolean) {
  useLayoutEffect(() => {
    if (!anchor || !el || !enabled) return;
    const update = () =>
      computePosition(anchor, el, {
        strategy: 'fixed',
        placement: PLACEMENTS[placement],
        middleware: [
          offset(6),
          flip({ padding: 8, fallbackPlacements: ['bottom-start', 'top-start', 'bottom-end', 'top-end', 'right-start', 'left-start'] }),
          shift({ padding: 8 }),
          size({
            padding: 8,
            apply({ availableHeight, availableWidth, rects }) {
              const side = placement === 'left' || placement === 'right';
              const w = Math.min(side ? maxWidth : Math.max(rects.reference.width, 320), maxWidth, availableWidth);
              Object.assign(el.style, { width: `${Math.max(280, w)}px`, maxHeight: `${Math.max(180, Math.min(availableHeight, maxHeight))}px` });
            },
          }),
        ],
      }).then(({ x, y }) => {
        el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      });
    return autoUpdate(anchor, el, update, { animationFrame: false });
  }, [anchor, el, maxWidth, maxHeight, placement, enabled]);
}

/** Dragged mode: a saved spot on screen (or offset from the field), kept inside the viewport. */
function useManualPosition(anchor: HTMLElement | null, el: HTMLElement | null, pos: SavedPos | null, maxWidth: number, maxHeight: number, enabled: boolean) {
  useLayoutEffect(() => {
    if (!el || !pos || !enabled) return;
    const update = () => {
      const w = Math.min(maxWidth, innerWidth - 16);
      Object.assign(el.style, { width: `${w}px`, maxHeight: `${Math.min(maxHeight, innerHeight - 16)}px` });
      const r = el.getBoundingClientRect();
      const { x, y } = resolvePos(pos, r.width, r.height, innerWidth, innerHeight, anchor?.getBoundingClientRect());
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    };
    update();
    if (pos.mode === 'field' && anchor) return autoUpdate(anchor, el, update, { animationFrame: false });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    addEventListener('resize', update);
    return () => {
      ro.disconnect();
      removeEventListener('resize', update);
    };
  }, [anchor, el, pos, maxWidth, maxHeight, enabled]);
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

function Item({ s, index, active, streaming, actions, badges, shortcut }: { s: Suggestion; index: number; active: boolean; streaming: boolean; actions: Actions; badges: boolean; shortcut: boolean }) {
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
          {s.title && badges && <span className="fp-badge">{SRC_LABEL[s.source]}</span>}
          {shortcut && index < 9 && <span className="fp-num">⌥{index + 1}</span>}
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
  const ui = st.ui;
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const refineRef = useRef<HTMLInputElement>(null);
  usePosition(st.anchor, el, st.maxWidth, ui.maxHeight, ui.placement, st.open && !st.manualPos && !dragging);
  useManualPosition(st.anchor, el, st.manualPos, st.maxWidth, ui.maxHeight, st.open && !!st.manualPos && !dragging);

  useEffect(() => {
    if (st.refineOpen) refineRef.current?.focus();
  }, [st.refineOpen]);
  useEffect(() => {
    if (!st.open) setMenuOpen(false);
  }, [st.open]);

  // ---- drag to move (header / grip) ----
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!ui.draggable || !el || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const r = el.getBoundingClientRect();
    drag.current = { px: e.clientX, py: e.clientY, x: r.left, y: r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setMenuOpen(false);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(8, d.x + e.clientX - d.px), innerWidth - r.width - 8);
    const y = Math.min(Math.max(8, d.y + e.clientY - d.py), innerHeight - Math.min(r.height, 120) - 8);
    el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  };
  const onPointerUp = () => {
    const d = drag.current;
    if (!d || !el) return;
    drag.current = null;
    setDragging(false);
    const r = el.getBoundingClientRect();
    if (Math.abs(r.left - d.x) < 3 && Math.abs(r.top - d.y) < 3) return; // a click, not a drag
    if (ui.dragAnchor === 'field' && st.anchor) {
      const a = st.anchor.getBoundingClientRect();
      actions.savePosition({ mode: 'field', dx: Math.round(r.left - a.left), dy: Math.round(r.top - a.top) });
    } else actions.savePosition(toScreenPos(r.left, r.top, r.width, r.height, innerWidth, innerHeight));
  };
  const dragProps = ui.draggable ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } : {};

  if (!st.open || !st.anchor || !st.field) return null;
  const items = visibleItems(st);
  const busy = st.status === 'retrieving' || st.status === 'generating' || st.status === 'streaming';
  const aiStart = st.instant.filter((x) => items.includes(x)).length;
  const q = st.field.label || st.field.placeholder || st.field.name || 'this field';
  const showSkeleton = (st.status === 'retrieving' || st.status === 'generating') && st.ai.length === 0;

  return (
    <div
      ref={setEl}
      className={`fp-panel${dragging ? ' fp-dragging' : ''}${st.pinned ? ' fp-pinned' : ''}`}
      style={{ ['--fp-opacity' as string]: String(ui.opacity / 100) }}
      role="listbox"
      aria-label="FormPilot suggestions"
      onMouseDown={(e) => {
        // Keep focus in the page field unless the user is clicking our refine box.
        if (!(e.target as HTMLElement).closest('input')) e.preventDefault();
      }}
    >
      {ui.showHeader ? (
        <div className={`fp-head${ui.draggable ? ' fp-draggable' : ''}`} {...dragProps} title={ui.draggable ? 'Drag to move' : undefined}>
          <span className="fp-brand">
            <Sparkles size={12} strokeWidth={2.6} />
            {ui.draggable && <GripVertical className="fp-grip-icon" size={12} />}
          </span>
          <span className="fp-head-title">
            <span className="fp-head-name">FormPilot{st.manualPos ? ' · moved' : ''}</span>
            <span className="fp-head-q" title={q}>
              {q}
            </span>
          </span>
          <button className="fp-iconbtn" data-on={st.pinned} title={st.pinned ? 'Unpin (close normally)' : 'Pin: keep on screen'} onClick={() => actions.togglePin()}>
            {st.pinned ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
          <div className="fp-menu-wrap">
            <button className="fp-iconbtn" data-on={menuOpen} title="More" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((m) => !m)}>
              <MoreHorizontal size={15} />
            </button>
            {menuOpen && (
              <div className="fp-menu" role="menu">
                <button role="menuitem" onClick={() => (setMenuOpen(false), actions.fillForm())} disabled={st.filling}>
                  <ListChecks size={14} /> Fill the whole form <span className="fp-menu-kbd">⌥⇧J</span>
                </button>
                {st.field.currentValue.trim() && (
                  <button role="menuitem" onClick={() => (setMenuOpen(false), actions.remember())}>
                    <BookmarkPlus size={14} /> Save my answer
                  </button>
                )}
                <button role="menuitem" onClick={() => (setMenuOpen(false), actions.resetPosition())} disabled={!st.manualPos}>
                  <LocateFixed size={14} /> Reset position
                </button>
                <div className="fp-menu-sep" />
                <button role="menuitem" onClick={() => (setMenuOpen(false), actions.pauseSite())}>
                  <PauseCircle size={14} /> Pause on this site
                </button>
                <button role="menuitem" onClick={() => (setMenuOpen(false), actions.openSettings('popup'))}>
                  <Settings2 size={14} /> Popup settings
                </button>
              </div>
            )}
          </div>
          <button className="fp-iconbtn" title="Close (Esc)" onClick={() => actions.close()}>
            <X size={15} />
          </button>
        </div>
      ) : (
        <div className={`fp-grip${ui.draggable ? ' fp-draggable' : ''}`} {...dragProps} title={ui.draggable ? 'Drag to move' : undefined}>
          <span className="fp-grip-bar" />
          {st.manualPos && (
            <button className="fp-grip-btn" title="Reset position" onClick={() => actions.resetPosition()}>
              <LocateFixed size={12} />
            </button>
          )}
          <button className="fp-grip-btn" data-on={st.pinned} title={st.pinned ? 'Unpin' : 'Pin: keep on screen'} onClick={() => actions.togglePin()}>
            {st.pinned ? <PinOff size={12} /> : <Pin size={12} />}
          </button>
          <button className="fp-grip-btn" title="Close (Esc)" onClick={() => actions.close()}>
            <X size={12} />
          </button>
        </div>
      )}

      <div className="fp-list">
        {ui.showGroupLabels && items.length > 0 && aiStart > 0 && <div className="fp-group">From your memory</div>}
        {items.map((s, i) => (
          <div key={s.id} style={{ display: 'contents' }}>
            {ui.showGroupLabels && i === aiStart && aiStart > 0 && st.ai.length > 0 && <div className="fp-group">AI suggestions</div>}
            <Item
              s={s}
              index={i}
              active={i === st.active}
              streaming={st.status === 'streaming' && i === items.length - 1 && s.source === 'ai'}
              actions={actions}
              badges={ui.showBadges}
              shortcut={ui.numberShortcuts && items.length > 1}
            />
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

      {st.hasProvider && ui.showActions && (
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

      {ui.showFooter && <div className="fp-foot">
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
      </div>}
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
