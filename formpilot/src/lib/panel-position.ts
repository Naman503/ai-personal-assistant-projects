/**
 * Saved positions of the dragged suggestion popup.
 *
 * "screen" positions are stored as fractions of the free space (0 = left/top edge,
 * 1 = right/bottom edge), so a popup docked at a corner stays docked when the window
 * is resized. "field" positions are an offset from the field's top-left corner.
 */

export type SavedPos = { mode: 'screen'; fx: number; fy: number } | { mode: 'field'; dx: number; dy: number };

const KEY = 'panelPositions';
type PosMap = Record<string, SavedPos>;

/** Storage key for the current site, or null when positions aren't remembered. */
export function positionKey(host: string, remember: 'per-site' | 'everywhere' | 'off'): string | null {
  if (remember === 'off') return null;
  return remember === 'everywhere' ? '*' : host || '*';
}

export async function loadPositions(): Promise<PosMap> {
  return ((await chrome.storage.local.get(KEY))[KEY] as PosMap | undefined) ?? {};
}

export async function savePosition(key: string, pos: SavedPos): Promise<void> {
  const all = await loadPositions();
  all[key] = pos;
  await chrome.storage.local.set({ [KEY]: all });
}

export async function clearPosition(key: string): Promise<void> {
  const all = await loadPositions();
  delete all[key];
  await chrome.storage.local.set({ [KEY]: all });
}

export async function clearAllPositions(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

export function watchPositions(cb: (all: PosMap) => void): () => void {
  const on = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && KEY in c) cb((c[KEY].newValue as PosMap | undefined) ?? {});
  };
  chrome.storage.onChanged.addListener(on);
  return () => chrome.storage.onChanged.removeListener(on);
}

const MARGIN = 8;

/** Screen x/y → stored fractions. */
export function toScreenPos(x: number, y: number, w: number, h: number, vw: number, vh: number): SavedPos {
  const freeX = Math.max(1, vw - w - 2 * MARGIN);
  const freeY = Math.max(1, vh - h - 2 * MARGIN);
  return { mode: 'screen', fx: clamp01((x - MARGIN) / freeX), fy: clamp01((y - MARGIN) / freeY) };
}

/** Stored position → top-left corner on screen, always fully inside the viewport. */
export function resolvePos(pos: SavedPos, w: number, h: number, vw: number, vh: number, field?: DOMRect | null): { x: number; y: number } {
  let x: number;
  let y: number;
  if (pos.mode === 'screen') {
    x = MARGIN + pos.fx * Math.max(0, vw - w - 2 * MARGIN);
    y = MARGIN + pos.fy * Math.max(0, vh - h - 2 * MARGIN);
  } else {
    x = (field?.left ?? 0) + pos.dx;
    y = (field?.top ?? 0) + pos.dy;
  }
  return { x: clamp(x, MARGIN, Math.max(MARGIN, vw - w - MARGIN)), y: clamp(y, MARGIN, Math.max(MARGIN, vh - h - MARGIN)) };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
function clamp01(v: number) {
  return clamp(v, 0, 1);
}
