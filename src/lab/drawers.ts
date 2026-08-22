// ============================================================================
// src/lab/drawers.ts — dock the lab's panels into edge DRAWERS with tabs.
// ============================================================================
//
// The lab grew one fixed-position panel at a time — picker, texture settings, fit controls, legend,
// surfaces — each one hard-coding its own corner. They now collide, they cover the model you are
// trying to judge, and adding the next one means finding another gap.
//
// So: two rails, left and right. Each panel becomes a drawer behind a TAB that sticks out of the
// edge; clicking a tab slides that drawer open and closes whatever else was open on that side. One
// panel visible per side means the viewport is never more than two panels' worth of covered, and a
// new panel costs a `dock()` call instead of a search for free pixels.
//
// The panels themselves are untouched: `dock` takes whatever element they built, strips the fixed
// positioning they set for themselves, and re-parents it. That keeps every panel module unaware
// this exists, so none of them has to agree on a layout system.
//
// Which drawer is open persists in the URL (`?drawers=left:right`), so a screenshot or a shared
// link comes back with the same panels showing.
//
// Pure VIEW/tooling — no sim, no determinism constraints.
// ============================================================================

export type Side = 'left' | 'right';

interface Drawer {
  id: string;
  label: string;
  side: Side;
  tab: HTMLElement;
  body: HTMLElement;
}

const RAIL_W = 26;      // the sliver of tab that stays visible
const PANEL_W = 268;

const rails: Record<Side, HTMLElement | null> = { left: null, right: null };
const shells: Record<Side, HTMLElement | null> = { left: null, right: null };
const drawers: Drawer[] = [];
const openBySide: Record<Side, string | null> = { left: null, right: null };

function ensureRail(side: Side): { rail: HTMLElement; shell: HTMLElement } {
  if (rails[side] && shells[side]) return { rail: rails[side]!, shell: shells[side]! };

  // the sliding panel body
  const shell = document.createElement('div');
  shell.id = `drawer-shell-${side}`;
  Object.assign(shell.style, {
    position: 'fixed', top: '54px', bottom: '54px', width: `${PANEL_W}px`, zIndex: '30',
    [side]: `${RAIL_W}px`,
    background: 'rgba(10,10,22,.9)',
    border: '1px solid rgba(120,130,170,.28)',
    borderRadius: side === 'left' ? '0 10px 10px 0' : '10px 0 0 10px',
    boxShadow: '0 4px 22px rgba(0,0,0,.5)',
    overflowY: 'auto', overflowX: 'hidden',
    padding: '10px 10px 14px',
    color: '#bcd', font: '11px/1.4 system-ui',
    // slide out of view rather than display:none — the panels inside keep their layout, so a
    // reopen never re-lays-out and nothing measures zero while hidden
    transform: `translateX(${side === 'left' ? '-' : ''}${PANEL_W + RAIL_W + 12}px)`,
    transition: 'transform .16s ease-out',
    visibility: 'hidden',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(shell);

  // the always-visible tab rail
  const rail = document.createElement('div');
  rail.id = `drawer-rail-${side}`;
  Object.assign(rail.style, {
    position: 'fixed', top: '54px', zIndex: '31', [side]: '0',
    display: 'flex', flexDirection: 'column', gap: '4px',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(rail);

  rails[side] = rail;
  shells[side] = shell;
  return { rail, shell };
}

function paintTab(d: Drawer): void {
  const on = openBySide[d.side] === d.id;
  Object.assign(d.tab.style, {
    background: on ? 'rgba(78,161,255,.22)' : 'rgba(10,10,22,.82)',
    color: on ? '#cfe3ff' : '#8a94b4',
    borderColor: on ? 'rgba(120,180,255,.55)' : 'rgba(120,130,170,.26)',
  } as Partial<CSSStyleDeclaration>);
}

function applySide(side: Side): void {
  const shell = shells[side];
  if (!shell) return;
  const openId = openBySide[side];
  for (const d of drawers.filter((x) => x.side === side)) {
    d.body.style.display = d.id === openId ? '' : 'none';
    paintTab(d);
  }
  const hidden = !openId;
  shell.style.transform = hidden ? `translateX(${side === 'left' ? '-' : ''}${PANEL_W + RAIL_W + 12}px)` : 'translateX(0)';
  shell.style.visibility = hidden ? 'hidden' : 'visible';
  writeUrl();
}

function writeUrl(): void {
  const u = new URLSearchParams(location.search);
  const v = `${openBySide.left ?? ''}:${openBySide.right ?? ''}`;
  if (v === ':') u.delete('drawers'); else u.set('drawers', v);
  history.replaceState(null, '', `${location.pathname}?${u.toString()}`);
}

/** Open a drawer by id (or close its side when already open). */
export function toggleDrawer(id: string): void {
  const d = drawers.find((x) => x.id === id);
  if (!d) return;
  openBySide[d.side] = openBySide[d.side] === id ? null : id;
  applySide(d.side);
}

/**
 * Move an existing panel element into a drawer.
 *
 * `el` keeps its own internal markup and behaviour; only its POSITIONING is taken over — every one
 * of these panels was written as `position: fixed` at a hand-picked corner, and those corners are
 * what collide.
 */
export function dock(el: HTMLElement, opts: { id: string; label: string; side: Side }): void {
  const { rail, shell } = ensureRail(opts.side);

  Object.assign(el.style, {
    position: 'static', left: 'auto', right: 'auto', top: 'auto', bottom: 'auto',
    // full width of the shell, border-box: these panels set their own pixel widths, and a panel
    // wider than its drawer spills past the rounded edge instead of scrolling inside it
    width: '100%', maxWidth: '100%', boxSizing: 'border-box', maxHeight: 'none', zIndex: 'auto',
    background: 'none', border: 'none', boxShadow: 'none', padding: '0',
    borderRadius: '0', overflow: 'visible',
  } as Partial<CSSStyleDeclaration>);
  // the picker builds an inner strip with its own chrome; flatten that too or it double-frames
  for (const child of Array.from(el.children) as HTMLElement[]) {
    if (child.style.width) child.style.width = '100%';
    child.style.maxWidth = '100%';
    child.style.boxSizing = 'border-box';
  }
  if (el instanceof HTMLDetailsElement) el.open = true; // the drawer IS the collapse now

  const body = document.createElement('div');
  body.appendChild(el);
  body.style.display = 'none';
  shell.appendChild(body);

  const tab = document.createElement('button');
  tab.textContent = opts.label;
  tab.title = opts.label;
  Object.assign(tab.style, {
    // vertical text so a readable label fits in a 26px rail
    writingMode: 'vertical-rl', textOrientation: 'mixed',
    padding: '10px 4px', border: '1px solid', cursor: 'pointer',
    borderRadius: opts.side === 'left' ? '0 8px 8px 0' : '8px 0 0 8px',
    font: '10px/1 system-ui', letterSpacing: '.06em',
    transition: 'background .12s, color .12s',
  } as Partial<CSSStyleDeclaration>);
  tab.addEventListener('click', () => toggleDrawer(opts.id));
  rail.appendChild(tab);

  drawers.push({ id: opts.id, label: opts.label, side: opts.side, tab, body });
  paintTab(drawers[drawers.length - 1]!);
}

/** Restore `?drawers=left:right`; falls back to the given defaults when the param is absent. */
export function restoreDrawers(defaults: { left?: string; right?: string } = {}): void {
  const raw = new URLSearchParams(location.search).get('drawers');
  const [l, r] = raw !== null ? raw.split(':') : [defaults.left ?? '', defaults.right ?? ''];
  openBySide.left = l && drawers.some((d) => d.id === l && d.side === 'left') ? l : null;
  openBySide.right = r && drawers.some((d) => d.id === r && d.side === 'right') ? r : null;
  applySide('left');
  applySide('right');
}

/** Hide the whole drawer system (the lab's "hide UI" toggle). */
export function setDrawersVisible(on: boolean): void {
  for (const side of ['left', 'right'] as const) {
    if (rails[side]) rails[side]!.style.display = on ? '' : 'none';
    if (shells[side]) shells[side]!.style.display = on ? '' : 'none';
  }
}
