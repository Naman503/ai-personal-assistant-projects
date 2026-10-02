/**
 * Structured, namespaced logger.
 *
 * Every line is prefixed with a coloured "FormPilot" badge and the namespace,
 * so you can filter the DevTools console with `FormPilot` or `bg:llm`.
 *
 *  - Content-script logs show in the *page* console (DevTools on the website).
 *  - Background logs show in the *service worker* console
 *    (chrome://extensions → FormPilot → "service worker").
 *  - Background also keeps a ring buffer that the Options → Logs page displays,
 *    and content scripts forward warnings/errors there too.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  t: number;
  level: LogLevel;
  ns: string;
  msg: string;
  data?: unknown;
  ctx: string;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '#64748b',
  info: '#2563eb',
  warn: '#d97706',
  error: '#dc2626',
};

let minLevel: LogLevel = 'debug';
let consoleEnabled = true;
let context = 'unknown';
const sinks = new Set<(e: LogEntry) => void>();

export function configureLogger(opts: { level?: LogLevel; console?: boolean; context?: string }) {
  if (opts.level) minLevel = opts.level;
  if (opts.console !== undefined) consoleEnabled = opts.console;
  if (opts.context) context = opts.context;
}

/** Subscribe to every log entry regardless of console level (used for the ring buffer / forwarding). */
export function addLogSink(fn: (e: LogEntry) => void): () => void {
  sinks.add(fn);
  return () => sinks.delete(fn);
}

function safeData(data: unknown): unknown {
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack };
  return data;
}

function emit(level: LogLevel, ns: string, msg: string, data?: unknown) {
  if (sinks.size) {
    const entry: LogEntry = { t: Date.now(), level, ns, msg, data: safeData(data), ctx: context };
    for (const s of sinks) {
      try {
        s(entry);
      } catch {
        /* a broken sink must never break logging */
      }
    }
  }
  if (!consoleEnabled || LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const fn =
    level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.info;
  const badge = 'background:#7c3aed;color:#fff;border-radius:3px;padding:1px 5px;font-weight:600';
  const nsStyle = `color:${LEVEL_COLOR[level]};font-weight:600`;
  // Warnings/errors also land on chrome://extensions → Errors, which shows %c codes as raw text,
  // so those use a plain prefix. Debug/info keep the coloured badge for DevTools.
  if (level === 'warn' || level === 'error') {
    const text = `[FormPilot] ${ns} › ${msg}`;
    if (data === undefined) fn(text);
    else fn(text, data);
    return;
  }
  if (data === undefined) fn(`%cFormPilot%c ${ns} ›`, badge, nsStyle, msg);
  else fn(`%cFormPilot%c ${ns} ›`, badge, nsStyle, msg, data);
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** Start a timer; call the returned fn to log the elapsed ms (and get it back). */
  time(label: string): (extra?: Record<string, unknown>) => number;
  child(sub: string): Logger;
}

export function createLogger(ns: string): Logger {
  return {
    debug: (m, d) => emit('debug', ns, m, d),
    info: (m, d) => emit('info', ns, m, d),
    warn: (m, d) => emit('warn', ns, m, d),
    error: (m, d) => emit('error', ns, m, d),
    time(label) {
      const start = performance.now();
      return (extra) => {
        const ms = Math.round(performance.now() - start);
        emit('debug', ns, `${label} took ${ms}ms`, extra);
        return ms;
      };
    },
    child: (sub) => createLogger(`${ns}:${sub}`),
  };
}

/** Fixed-size buffer of recent log entries. */
export class LogRing {
  private buf: LogEntry[] = [];
  constructor(private max = 1000) {}
  push(e: LogEntry) {
    this.buf.push(e);
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
  }
  all(): LogEntry[] {
    return this.buf.slice();
  }
  clear() {
    this.buf = [];
  }
}
