// ============================================================================
// src/lab/page-nav.ts — one switcher across every authoring page.
// ============================================================================
//
// There are eight of these pages and no way between them: you either remembered the filename or went
// back to CLAUDE.md to look it up. This is one menu, mounted by each page, listing them all and marking
// the one you are on.
//
// THE LIST LIVES HERE, ONCE. A per-page copy would be eight lists to keep in step, and the one that
// went stale would be the page nobody opens — which is exactly the page you would be hunting for.
//
// IT OVERLAYS, IT DOES NOT DISPLACE. A full-width bar would have to be made room for, and these six
// pages lay themselves out six different ways — a flex body with a left panel, a canvas at 0,0, two
// with fixed rails at top:54px. A collapsed pill costs one corner and needs no page to change; the
// list only exists while it is open.
//
// `cell-snap.html` is DELIBERATELY ABSENT from the mounting, though it is listed as a destination. It
// renders one frame and stops so screenshots stay byte-comparable, and chrome in every snapshot is
// exactly what it exists to avoid. It is reachable FROM everywhere and simply does not carry the menu.
//
// Pure VIEW/tooling — no sim, no determinism constraints.
// ============================================================================

interface Page {
  /** Relative to the vite base, so it works under `/ascent/` and at root alike. */
  file: string;
  label: string;
  /** What you go there to do. Shown in the menu, so the label can stay short. */
  hint: string;
}

/** Grouped by what you are doing rather than alphabetically: author, then look, then play. */
const SECTIONS: readonly { title: string; pages: readonly Page[] }[] = [
  {
    title: 'author',
    pages: [
      { file: 'cell-editor.html', label: 'Cell editor', hint: '2u structures — paint the point lattice, live 3D' },
      { file: 'tile-editor.html', label: 'Tile editor', hint: "4u — a tile's 9 cells as domains + connectivity" },
      { file: 'board.html', label: 'Board', hint: 'stamp room templates; commit vs rollback on overlap' },
    ],
  },
  {
    title: 'look',
    pages: [
      { file: 'lab.html', label: 'Asset lab', hint: 'one object: materials, surfaces, collision box-fit' },
      { file: 'sheet.html', label: 'Contact sheet', hint: 'every object at once under one material profile' },
      { file: 'walltile.html', label: 'Wall-tile', hint: 'one WallTile → placements → meshes (4u, legacy)' },
      { file: 'cell-snap.html', label: 'Cell snap', hint: 'the 2u pipeline rendered ONCE — no controls' },
    ],
  },
  { title: 'play', pages: [{ file: 'index.html', label: 'Game', hint: 'the sandbox' }] },
];

const here = (): string => location.pathname.split('/').pop() || 'index.html';

/** The human name of the page you are on, for the closed pill. */
function currentLabel(): string {
  const f = here();
  for (const s of SECTIONS) for (const p of s.pages) if (p.file === f) return p.label;
  return 'Pages';
}

/**
 * Mount the switcher — a pill at the top-left that opens a list.
 *
 * Safe to call from any page: it appends one fixed element and changes no layout.
 */
export function mountPageNav(container: HTMLElement = document.body): HTMLElement {
  const root = document.createElement('div');
  root.id = 'page-nav';
  Object.assign(root.style, {
    position: 'fixed', left: '8px', top: '8px', zIndex: '90',
    font: '11px/1.2 system-ui, sans-serif',
  } as Partial<CSSStyleDeclaration>);

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.innerHTML = `<span style="opacity:.55">≡</span>&nbsp; ${currentLabel()}`;
  Object.assign(pill.style, {
    display: 'flex', alignItems: 'center', padding: '6px 10px', borderRadius: '8px',
    background: 'rgba(8,9,14,.88)', color: '#c3cad8',
    border: '1px solid rgba(120,130,170,.24)', cursor: 'pointer',
    font: 'inherit', letterSpacing: '.02em',
  } as Partial<CSSStyleDeclaration>);

  const menu = document.createElement('div');
  Object.assign(menu.style, {
    display: 'none', marginTop: '4px', padding: '6px', minWidth: '190px',
    background: 'rgba(8,9,14,.96)', border: '1px solid rgba(120,130,170,.24)',
    borderRadius: '10px', boxShadow: '0 8px 26px rgba(0,0,0,.5)',
  } as Partial<CSSStyleDeclaration>);

  const f = here();
  for (const section of SECTIONS) {
    const h = document.createElement('div');
    h.textContent = section.title;
    Object.assign(h.style, {
      padding: '5px 7px 3px', color: '#6f7885', textTransform: 'uppercase',
      fontSize: '9px', letterSpacing: '.1em',
    } as Partial<CSSStyleDeclaration>);
    menu.append(h);

    for (const p of section.pages) {
      const current = p.file === f;
      const a = document.createElement('a');
      a.href = p.file;
      a.title = p.hint;
      a.innerHTML = `<div>${p.label}</div><div style="opacity:.45;font-size:10px;margin-top:1px">${p.hint}</div>`;
      Object.assign(a.style, {
        display: 'block', padding: '5px 7px', borderRadius: '6px', textDecoration: 'none',
        color: current ? '#0c0e14' : '#c8cfdc',
        background: current ? '#8fa4d8' : 'transparent',
        pointerEvents: current ? 'none' : 'auto',   // the page you are on is not a link anywhere
      } as Partial<CSSStyleDeclaration>);
      if (!current) {
        a.addEventListener('mouseenter', () => { a.style.background = 'rgba(120,130,170,.18)'; });
        a.addEventListener('mouseleave', () => { a.style.background = 'transparent'; });
      }
      menu.append(a);
    }
  }

  const setOpen = (on: boolean): void => { menu.style.display = on ? 'block' : 'none'; };
  pill.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.style.display === 'none'); });
  // click anywhere else, or Escape, closes it — a menu you cannot dismiss is worse than no menu
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  menu.addEventListener('click', (e) => e.stopPropagation());

  root.append(pill, menu);
  container.append(root);
  return root;
}
