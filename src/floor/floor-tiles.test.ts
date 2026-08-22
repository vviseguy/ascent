import { describe, it, expect } from 'vitest';
import { generateFloor } from './generate.ts';
import { floorToTileGrid, floorTiles } from './floor-tiles.ts';

const floored = (t: { floor: { nw: string; ne: string; sw: string; se: string } } | null): boolean =>
  !!t && (t.floor.nw !== 'none' || t.floor.ne !== 'none' || t.floor.sw !== 'none' || t.floor.se !== 'none');

describe('floor-tiles — Floor → TileGrid → resolved tiles', () => {
  const floor = generateFloor({ gridSize: 6, openness: 0.4, guaranteedRoutes: 2, seed: 1234n });

  it('builds one tile per cell with no conflicts (every cell collapses)', () => {
    const g = floorToTileGrid(floor);
    expect(g.w).toBe(floor.width);
    expect(g.h).toBe(floor.height);
    const tiles = floorTiles(floor);
    expect(tiles).toHaveLength(floor.width * floor.height);
    expect(tiles.every((t) => t !== null)).toBe(true);
  });

  it('every ROOM cell gets a floor (room templates stamped)', () => {
    const tiles = floorTiles(floor);
    const roomCells = floor.cells.filter((c) => c.cellType === 'ROOM');
    expect(roomCells.length).toBeGreaterThan(0);
    expect(roomCells.every((c) => floored(tiles[c.id]!))).toBe(true);
  });

  it('CORRIDOR/DOORWAY cells are floored (walkable)', () => {
    const tiles = floorTiles(floor);
    const lanes = floor.cells.filter((c) => c.cellType === 'CORRIDOR' || c.cellType === 'DOORWAY');
    if (lanes.length) expect(lanes.every((c) => floored(tiles[c.id]!))).toBe(true);
  });

  it('is deterministic (same floor → identical tiles)', () => {
    expect(floorTiles(floor)).toEqual(floorTiles(floor));
  });
});
