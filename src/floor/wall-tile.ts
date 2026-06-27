/**
 * src/floor/wall-tile.ts — the WALL-TILE structural model + resolver (docs/16 §2).
 *
 * A wall occupies its OWN 4u square (walls own tiles, not edges). A tile's "piece" is
 * NOT an enum — it is PARAMETERS that the resolver turns into a concrete arrangement:
 *
 *   - four CARDINAL CONNECTIONS (N/E/S/W), each `none | wall | barrier` — does an arm
 *     reach from the tile's centre out to that edge to meet the neighbour, and as what.
 *   - a CENTRE axis (`none | EW | NS | both`) — what fills the middle, on which axes.
 *   - a CENTRE TYPE (`wall | barrier`) — what the centre material is.
 *   - a WALL TYPE (wide, extensible) — the through-passage variety (solid/door/window/…),
 *     meaningful only for a single-axis WALL centre (EW or NS).
 *
 * The classic pieces (cap / straight / corner / tee / cross / column) are DERIVED from
 * (connections, centre) — never stored. A `both` centre means "it bulges, it is not a
 * flat wall" (corner/tee/cross/column); a column is just `both` with no connections.
 *
 * THE RESOLUTION RULE (the heart of this file):
 *   An arm whose TYPE and AXIS match the centre flows into it as one continuous **run**.
 *   An arm that does NOT match **caps** at the centre — a wall cap, or a half-barrier
 *   reaching the middle. **Overlap is fine.** So E+W barriers around a `both`/`wall`
 *   centre resolve to a barrier crossbar with a wall column poking through it:
 *        ||          (the wall column — full height)
 *      =====         (the barrier crossbar — low; the column overlaps it in the middle)
 *
 * Pure + deterministic: a tile always resolves to the same arrangement. No RNG, no
 * floats, no Map iteration on output paths — safe for the sim / blueprint layer.
 *
 * Item placement (objects on the wall/floor corners) is deferred — see docs/16 §2
 * "content + the placement machine".
 */

export type Dir = 'N' | 'E' | 'S' | 'W';
export const DIRS: readonly Dir[] = ['N', 'E', 'S', 'W'];

/** A side's connection: nothing, a full-height wall arm, or a low barrier (handrail-like). */
export type Connection = 'none' | 'wall' | 'barrier';

/** What fills the tile's centre, and on which axis/axes. */
export type CentreAxis = 'none' | 'EW' | 'NS' | 'both';

/** What the centre material IS — a full wall, or a low barrier. */
export type CentreType = 'wall' | 'barrier';

/**
 * The through-passage variety of a single-axis WALL centre (EW/NS only). Wide + extensible
 * (new openings drop in here, not as new pieces). Only `solid` blocks fully; the others are
 * the openings collision + the solvability verifier read. (A barrier centre carries no
 * wallType; a barrier "style" enum could be added in parallel later.)
 */
export type WallType = 'solid' | 'door' | 'window' | 'hole' | 'arch' | 'low_gate';

/** The full parameterization of one wall tile (one 4u square). */
export interface WallTile {
  N: Connection;
  E: Connection;
  S: Connection;
  W: Connection;
  /** What fills the centre. */
  centre: CentreAxis;
  /** Centre material — read only when `centre !== 'none'`. */
  centreType: CentreType;
  /** Through-passage — read only when `centreType === 'wall'` and `centre` is `EW`|`NS`. */
  wallType: WallType;
}

/* --------------------------------- arrangement -------------------------------- */

/** How an arm meets the centre. `run` = continuous (matched type+axis); `cap` = ends at centre. */
export type ArmTerminal = 'run' | 'cap';

export interface ArmPiece {
  type: Connection;
  terminal: ArmTerminal;
}

export interface CentrePiece {
  axis: CentreAxis;
  /** `'none'` exactly when `axis === 'none'`. */
  type: CentreType | 'none';
  /** Present only for a single-axis WALL centre. */
  wallType?: WallType;
}

/** Named common case; `custom` covers mixed wall/barrier or an axis/connector mismatch. */
export type WallCase =
  | 'empty' //    nothing
  | 'column' //   both-axis WALL centre, no connections → freestanding pillar
  | 'post' //     both-axis BARRIER centre, no connections → freestanding barrier hub
  | 'cap' //      one connection
  | 'straight' // two opposite connections + a matching single-axis centre
  | 'caps' //     two connections, no joining centre → independent caps across a gap
  | 'corner' //   two adjacent connections + a both-axis centre → a turn
  | 'tee' //      three connections + a both-axis centre
  | 'cross' //    four connections + a both-axis centre
  | 'custom'; //  mixed types, or a connector/axis that doesn't line up

/** The resolved geometry: a centre + four arms. Overlaps allowed. */
export interface WallArrangement {
  tile: WallTile;
  centre: CentrePiece;
  arms: Record<Dir, ArmPiece>;
  case: WallCase;
}

/* ----------------------------------- resolver --------------------------------- */

const axisOf = (d: Dir): 'EW' | 'NS' => (d === 'E' || d === 'W' ? 'EW' : 'NS');

/** Does the centre have material on the axis of direction `d`? */
const centreCoversDir = (axis: CentreAxis, d: Dir): boolean =>
  axis === 'both' || axis === axisOf(d);

/**
 * Resolve a tile to its arrangement. Total: every input resolves (never throws). An arm
 * `run`s iff it shares the centre's type AND lies on a centre axis; otherwise it `cap`s
 * (a wall cap, or a half-barrier to the centre — overlap is allowed).
 */
export function resolveWallTile(tile: WallTile): WallArrangement {
  const centre: CentrePiece = {
    axis: tile.centre,
    type: tile.centre === 'none' ? 'none' : tile.centreType,
  };
  if (centre.type === 'wall' && (tile.centre === 'EW' || tile.centre === 'NS')) {
    centre.wallType = tile.wallType;
  }

  const arms = {} as Record<Dir, ArmPiece>;
  for (const d of DIRS) {
    const conn = tile[d];
    if (conn === 'none') {
      arms[d] = { type: 'none', terminal: 'cap' };
      continue;
    }
    const runs = centre.type === conn && centreCoversDir(tile.centre, d);
    arms[d] = { type: conn, terminal: runs ? 'run' : 'cap' };
  }

  return { tile, centre, arms, case: classify(tile) };
}

/** Classify a tile into a common named case (or `custom`). Pure function of the params. */
export function classify(tile: WallTile): WallCase {
  const conns = DIRS.filter((d) => tile[d] !== 'none');
  const n = conns.length;

  // Material is "uniform" when every present thing (connections + a real centre) is one type.
  const types = new Set<string>(conns.map((d) => tile[d]));
  if (tile.centre !== 'none') types.add(tile.centreType);
  if (types.size > 1) return 'custom';

  if (n === 0) {
    if (tile.centre === 'both') return tile.centreType === 'wall' ? 'column' : 'post';
    if (tile.centre === 'none') return 'empty';
    return 'custom'; // a single-axis centre floating with no connections — degenerate
  }
  if (n === 1) return 'cap';
  if (n === 2) {
    const a = conns[0]!;
    const b = conns[1]!;
    const opposite = (a === 'N' && b === 'S') || (a === 'E' && b === 'W');
    if (opposite) {
      if (tile.centre === axisOf(a)) return 'straight';
      if (tile.centre === 'none') return 'caps';
      return 'custom';
    }
    // adjacent pair = a corner candidate
    if (tile.centre === 'both') return 'corner';
    if (tile.centre === 'none') return 'caps';
    return 'custom';
  }
  if (n === 3) return tile.centre === 'both' ? 'tee' : 'custom';
  return tile.centre === 'both' ? 'cross' : 'custom'; // n === 4
}

/* ----------------------------------- describe --------------------------------- */

/** A compact, human-readable summary of a tile's resolved arrangement (for tests/docs). */
export function describeWallTile(tile: WallTile): string {
  const a = resolveWallTile(tile);
  const conns = DIRS.filter((d) => tile[d] !== 'none').map((d) => `${d}:${tile[d]}`);
  const centre =
    a.centre.type === 'none'
      ? 'centre:none'
      : `centre:${a.centre.axis}/${a.centre.type}${a.centre.wallType ? `/${a.centre.wallType}` : ''}`;
  const caps = DIRS.filter((d) => a.arms[d].type !== 'none' && a.arms[d].terminal === 'cap');
  const tail = caps.length ? `  (caps: ${caps.join(',')})` : '';
  return `${a.case} { ${conns.join(' ') || 'no connections'} | ${centre} }${tail}`;
}
