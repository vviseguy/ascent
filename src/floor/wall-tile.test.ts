import { describe, it, expect } from 'vitest';
import {
  DIRS,
  resolveWallTile,
  classify,
  describeWallTile,
  validateWallTile,
  uniformFloor,
  type WallTile,
  type Connection,
  type CentreAxis,
  type CentreType,
  type WallType,
  type FloorMaterial,
  type CornerFloors,
} from './wall-tile.ts';

/** All-corners-one-material floor (the common case). */
const F = (m: FloorMaterial = 'stone'): CornerFloors => ({ nw: m, ne: m, sw: m, se: m });

/** Build a tile with sane defaults; override only the fields a case cares about. */
const T = (p: Partial<WallTile>): WallTile => ({
  floor: F('stone'),
  N: 'none',
  E: 'none',
  S: 'none',
  W: 'none',
  centre: 'none',
  centreType: 'wall',
  wallType: 'solid',
  ...p,
});

describe('wall-tile resolver — the common WALL entities', () => {
  it('empty: nothing anywhere', () => {
    expect(classify(T({}))).toBe('empty');
  });

  it('column: both-axis wall centre, no connections → a freestanding pillar', () => {
    const a = resolveWallTile(T({ centre: 'both', centreType: 'wall' }));
    expect(a.case).toBe('column');
    expect(a.centre).toEqual({ axis: 'both', type: 'wall' }); // no wallType on a `both` centre
    for (const d of DIRS) expect(a.arms[d]).toEqual({ type: 'none', terminal: 'cap' });
  });

  it('cap: a single wall arm ends at the centre', () => {
    const a = resolveWallTile(T({ W: 'wall' }));
    expect(a.case).toBe('cap');
    expect(a.arms.W).toEqual({ type: 'wall', terminal: 'cap' });
  });

  it('straight: opposite walls + a matching single-axis centre flow through (a RUN)', () => {
    const a = resolveWallTile(T({ E: 'wall', W: 'wall', centre: 'EW', centreType: 'wall' }));
    expect(a.case).toBe('straight');
    expect(a.centre).toEqual({ axis: 'EW', type: 'wall', wallType: 'solid' });
    expect(a.arms.E).toEqual({ type: 'wall', terminal: 'run' });
    expect(a.arms.W).toEqual({ type: 'wall', terminal: 'run' });
  });

  it('straight with a DOOR: same topology, wallType carries the opening', () => {
    const a = resolveWallTile(T({ N: 'wall', S: 'wall', centre: 'NS', centreType: 'wall', wallType: 'door' }));
    expect(a.case).toBe('straight');
    expect(a.centre.wallType).toBe('door');
    expect(a.arms.N.terminal).toBe('run');
  });

  it('caps: two opposite walls with NO centre → two caps across a gap', () => {
    const a = resolveWallTile(T({ E: 'wall', W: 'wall', centre: 'none' }));
    expect(a.case).toBe('caps');
    expect(a.arms.E).toEqual({ type: 'wall', terminal: 'cap' });
    expect(a.arms.W).toEqual({ type: 'wall', terminal: 'cap' });
  });

  it('corner: two adjacent walls + a both centre → it turns', () => {
    const a = resolveWallTile(T({ N: 'wall', E: 'wall', centre: 'both', centreType: 'wall' }));
    expect(a.case).toBe('corner');
    expect(a.arms.N.terminal).toBe('run');
    expect(a.arms.E.terminal).toBe('run');
  });

  it('tee: three walls + a both centre', () => {
    const a = resolveWallTile(T({ W: 'wall', E: 'wall', S: 'wall', centre: 'both', centreType: 'wall' }));
    expect(a.case).toBe('tee');
    expect(a.arms.W.terminal).toBe('run');
    expect(a.arms.S.terminal).toBe('run');
    expect(a.arms.N).toEqual({ type: 'none', terminal: 'cap' });
  });

  it('cross: four walls + a both centre', () => {
    const a = resolveWallTile(T({ N: 'wall', E: 'wall', S: 'wall', W: 'wall', centre: 'both', centreType: 'wall' }));
    expect(a.case).toBe('cross');
    for (const d of DIRS) expect(a.arms[d].terminal).toBe('run');
  });
});

describe('wall-tile resolver — the BARRIER equivalents', () => {
  it('post: both barrier centre, no connections → freestanding barrier hub', () => {
    expect(classify(T({ centre: 'both', centreType: 'barrier' }))).toBe('post');
  });

  it('barrier straight / corner / tee / cross resolve like walls but as barriers', () => {
    expect(classify(T({ E: 'barrier', W: 'barrier', centre: 'EW', centreType: 'barrier' }))).toBe('straight');
    expect(classify(T({ N: 'barrier', E: 'barrier', centre: 'both', centreType: 'barrier' }))).toBe('corner');
    expect(classify(T({ W: 'barrier', E: 'barrier', S: 'barrier', centre: 'both', centreType: 'barrier' }))).toBe('tee');
    expect(
      classify(T({ N: 'barrier', E: 'barrier', S: 'barrier', W: 'barrier', centre: 'both', centreType: 'barrier' })),
    ).toBe('cross');
  });
});

describe('wall-tile resolver — the MIXED-type cases (the resolution rule)', () => {
  it("E+W barriers around a both/wall centre → barrier crossbar + wall column (the '=||=' case)", () => {
    // The user's worked example: a barrier all the way across with a column in the middle.
    const a = resolveWallTile(T({ E: 'barrier', W: 'barrier', centre: 'both', centreType: 'wall' }));
    expect(a.case).toBe('custom'); // mixed wall + barrier
    expect(a.centre).toEqual({ axis: 'both', type: 'wall' }); // the wall column
    // barriers don't match the wall centre → each caps at the centre (a half-barrier), overlapping the column
    expect(a.arms.E).toEqual({ type: 'barrier', terminal: 'cap' });
    expect(a.arms.W).toEqual({ type: 'barrier', terminal: 'cap' });
  });

  it('walls into a barrier centre → wall arms cap against the barrier hub', () => {
    const a = resolveWallTile(T({ E: 'wall', W: 'wall', centre: 'both', centreType: 'barrier' }));
    expect(a.case).toBe('custom');
    expect(a.arms.E).toEqual({ type: 'wall', terminal: 'cap' });
    expect(a.arms.W).toEqual({ type: 'wall', terminal: 'cap' });
  });

  it('a wall arm whose axis the centre does not cover → caps (no run)', () => {
    // W wall, but the centre only runs NS → the W arm is off-axis → it caps.
    const a = resolveWallTile(T({ W: 'wall', centre: 'NS', centreType: 'wall' }));
    expect(a.arms.W.terminal).toBe('cap');
  });
});

describe('wall-tile — floor + validation', () => {
  it('a plain floor square is just an all-none tile with a stone floor', () => {
    const floorSq = T({ floor: F('stone') });
    expect(classify(floorSq)).toBe('empty');
    expect(validateWallTile(floorSq)).toEqual([]);
    expect(uniformFloor(floorSq.floor)).toBe('stone');
  });

  it('a hole (all-none floor) is well-formed; uniformFloor is null', () => {
    const hole = T({ floor: F('none') });
    expect(validateWallTile(hole)).toEqual([]);
    expect(uniformFloor(hole.floor)).toBeNull();
  });

  it('per-corner floors: a dirt↔stone split is not a uniform tile', () => {
    const split: CornerFloors = { nw: 'stone', ne: 'stone', sw: 'dirt', se: 'dirt' };
    expect(uniformFloor(split)).toBeNull();
    expect(validateWallTile(T({ floor: split }))).toEqual([]);
  });

  it('a straight wall is valid', () => {
    expect(validateWallTile(T({ E: 'wall', W: 'wall', centre: 'EW' }))).toEqual([]);
  });

  it('an EW centre with NO E/W connection is INVALID (floating bar)', () => {
    const issues = validateWallTile(T({ centre: 'EW', centreType: 'wall' }));
    expect(issues.map((i) => i.code)).toContain('floating-EW-centre');
  });

  it('an NS centre with NO N/S connection is INVALID', () => {
    const issues = validateWallTile(T({ centre: 'NS' }));
    expect(issues.map((i) => i.code)).toContain('floating-NS-centre');
  });

  it('a single connection on the centre axis is enough to be valid (the ramp-down edge)', () => {
    expect(validateWallTile(T({ W: 'wall', centre: 'EW' }))).toEqual([]);
  });
});

describe('wall-tile resolver — totality + invariants over EVERY input', () => {
  const CONN: Connection[] = ['none', 'wall', 'barrier'];
  const AXES: CentreAxis[] = ['none', 'EW', 'NS', 'both'];
  const CTYPES: CentreType[] = ['wall', 'barrier'];
  const WT: WallType[] = ['solid', 'door'];

  it('every combination resolves (never throws) and obeys the run/cap + centre invariants', () => {
    let count = 0;
    for (const N of CONN)
      for (const E of CONN)
        for (const S of CONN)
          for (const W of CONN)
            for (const centre of AXES)
              for (const centreType of CTYPES)
                for (const wallType of WT) {
                  const tile: WallTile = { floor: F('stone'), N, E, S, W, centre, centreType, wallType };
                  const a = resolveWallTile(tile);
                  count++;

                  // centre.type is 'none' iff the axis is 'none'
                  expect(a.centre.type === 'none').toBe(centre === 'none');
                  // wallType present iff a single-axis WALL centre
                  const expectWallType = centreType === 'wall' && (centre === 'EW' || centre === 'NS');
                  expect(a.centre.wallType !== undefined).toBe(expectWallType);

                  for (const d of DIRS) {
                    const arm = a.arms[d];
                    expect(arm.type).toBe(tile[d]); // arm mirrors the connection
                    if (arm.terminal === 'run') {
                      // a RUN only happens for a matching type on a covered axis
                      expect(tile[d]).not.toBe('none');
                      expect(a.centre.type).toBe(tile[d]);
                      const onAxis = centre === 'both' || centre === (d === 'E' || d === 'W' ? 'EW' : 'NS');
                      expect(onAxis).toBe(true);
                    }
                  }
                }
    expect(count).toBe(CONN.length ** 4 * AXES.length * CTYPES.length * WT.length); // 3^4 * 4 * 2 * 2 = 1296
  });

  it('describeWallTile produces a readable line for the worked example', () => {
    const s = describeWallTile(T({ E: 'barrier', W: 'barrier', centre: 'both', centreType: 'wall' }));
    expect(s).toContain('custom');
    expect(s).toContain('centre:both/wall');
    expect(s).toContain('caps: E,W');
  });
});
