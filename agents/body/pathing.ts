import type { LevelGeometry } from "@/agents/world/levels";
import { PLAYER_RADIUS, type VoxelWorld, blockedAt } from "@/game/world/collision";
import { cellOf } from "@/game/world/voxels";

/**
 * Finding a way from here to there on a one-metre grid.
 *
 * The movement itself is the same swept collision a human walks with
 * (collision.ts), so a path only has to be *plausible*: cells an agent can
 * stand in, joined by rises it can step up. A* over those, then pulled taut so
 * the agent walks straight lines between corners rather than zigzagging cell
 * to cell. Everything is bounded — a search box and a node budget — because a
 * path that cannot be found quickly is better given up on than waited for.
 */

export interface Point {
  x: number;
  z: number;
}

/** Steepest rise between neighbouring cells an agent will attempt, in metres. */
const MAX_RISE = 1.1;
/** Keep this far above the water line. */
const SHORE_MARGIN = 0.2;
const DEFAULT_MAX_NODES = 4000;
/** Search box around the start and goal, in cells. */
const SEARCH_MARGIN = 14;

interface Walkability {
  ground: (cx: number, cz: number) => number | null;
}

/** Ground height of a cell an agent can stand in, or null. Memoised per search. */
function walkability(world: VoxelWorld, geometry: LevelGeometry): Walkability {
  const cache = new Map<number, number | null>();
  const limit = geometry.halfSize != null ? geometry.halfSize - PLAYER_RADIUS - 0.2 : Infinity;
  return {
    ground(cx, cz) {
      const key = cx * 100003 + cz;
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const x = cx + 0.5;
      const z = cz + 0.5;
      let result: number | null = world.terrainAt(x, z);
      if (Math.abs(x) > limit || Math.abs(z) > limit) {
        result = null;
      } else if (geometry.seaLevel != null && result < geometry.seaLevel + SHORE_MARGIN) {
        result = null;
      } else if (blockedAt(world, x, result, z)) {
        result = null;
      }
      cache.set(key, result);
      return result;
    },
  };
}

/** Minimal binary heap keyed on f-score. */
class Heap {
  private items: Array<{ key: number; f: number }> = [];
  get size(): number {
    return this.items.length;
  }
  push(key: number, f: number): void {
    const items = this.items;
    items.push({ key, f });
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].f <= items[index].f) {
        break;
      }
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }
  pop(): number | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (top == null || last == null) {
      return undefined;
    }
    if (items.length > 0) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && items[left].f < items[smallest].f) {
          smallest = left;
        }
        if (right < items.length && items[right].f < items[smallest].f) {
          smallest = right;
        }
        if (smallest === index) {
          break;
        }
        [items[smallest], items[index]] = [items[index], items[smallest]];
        index = smallest;
      }
    }
    return top.key;
  }
}

const NEIGHBOURS: Array<[number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/** Nearest standable cell to a point, searching outwards a few cells. */
function nearestStandable(
  walk: Walkability,
  cx: number,
  cz: number,
  radius: number,
): [number, number] | null {
  for (let r = 0; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) {
          continue;
        }
        if (walk.ground(cx + dx, cz + dz) != null) {
          return [cx + dx, cz + dz];
        }
      }
    }
  }
  return null;
}

/** True when a straight walk from a to b stays on standable, climbable cells. */
function straightWalkable(walk: Walkability, a: Point, b: Point): boolean {
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(distance / 0.4));
  let previous = walk.ground(cellOf(a.x), cellOf(a.z));
  if (previous == null) {
    return false;
  }
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    // The body is wider than a line: check either side of it too.
    for (const [ox, oz] of [
      [0, 0],
      [PLAYER_RADIUS, 0],
      [-PLAYER_RADIUS, 0],
      [0, PLAYER_RADIUS],
      [0, -PLAYER_RADIUS],
    ]) {
      if (walk.ground(cellOf(x + ox), cellOf(z + oz)) == null) {
        return false;
      }
    }
    const ground = walk.ground(cellOf(x), cellOf(z));
    if (ground == null || Math.abs(ground - previous) > MAX_RISE) {
      return false;
    }
    previous = ground;
  }
  return true;
}

/**
 * Waypoints from `from` to (near) `to`, excluding the start, or null when no
 * way was found within the budget. The last waypoint is the reachable cell
 * nearest the goal, which may not be the goal itself.
 */
export function findPath(
  world: VoxelWorld,
  geometry: LevelGeometry,
  from: Point,
  to: Point,
  maxNodes: number = DEFAULT_MAX_NODES,
): Point[] | null {
  const walk = walkability(world, geometry);
  const start = nearestStandable(walk, cellOf(from.x), cellOf(from.z), 2);
  const goal = nearestStandable(walk, cellOf(to.x), cellOf(to.z), 4);
  if (start == null || goal == null) {
    return null;
  }

  const direct = { x: goal[0] + 0.5, z: goal[1] + 0.5 };
  if (straightWalkable(walk, from, direct)) {
    return [direct];
  }

  const minX = Math.min(start[0], goal[0]) - SEARCH_MARGIN;
  const maxX = Math.max(start[0], goal[0]) + SEARCH_MARGIN;
  const minZ = Math.min(start[1], goal[1]) - SEARCH_MARGIN;
  const maxZ = Math.max(start[1], goal[1]) + SEARCH_MARGIN;
  const width = maxX - minX + 1;
  const keyOf = (cx: number, cz: number): number => (cz - minZ) * width + (cx - minX);
  const cellOfKey = (key: number): [number, number] => [
    (key % width) + minX,
    Math.floor(key / width) + minZ,
  ];
  const heuristic = (cx: number, cz: number): number => Math.hypot(goal[0] - cx, goal[1] - cz);

  const open = new Heap();
  const cost = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const startKey = keyOf(start[0], start[1]);
  const goalKey = keyOf(goal[0], goal[1]);
  cost.set(startKey, 0);
  open.push(startKey, heuristic(start[0], start[1]));

  let expanded = 0;
  let best = startKey;
  let bestH = heuristic(start[0], start[1]);

  while (open.size > 0 && expanded < maxNodes) {
    const current = open.pop();
    if (current == null) {
      break;
    }
    if (current === goalKey) {
      best = goalKey;
      break;
    }
    expanded++;
    const [cx, cz] = cellOfKey(current);
    const here = walk.ground(cx, cz);
    if (here == null) {
      continue;
    }
    const h = heuristic(cx, cz);
    if (h < bestH) {
      bestH = h;
      best = current;
    }
    for (const [dx, dz, step] of NEIGHBOURS) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) {
        continue;
      }
      const there = walk.ground(nx, nz);
      if (there == null || Math.abs(there - here) > MAX_RISE) {
        continue;
      }
      // No cutting corners past something solid.
      if (dx !== 0 && dz !== 0 && (walk.ground(cx + dx, cz) == null || walk.ground(cx, cz + dz) == null)) {
        continue;
      }
      const next = keyOf(nx, nz);
      const tentative = (cost.get(current) ?? Infinity) + step + Math.abs(there - here) * 0.5;
      if (tentative < (cost.get(next) ?? Infinity)) {
        cost.set(next, tentative);
        cameFrom.set(next, current);
        open.push(next, tentative + heuristic(nx, nz));
      }
    }
  }

  if (best === startKey) {
    return null;
  }

  const cells: Point[] = [];
  for (let key: number | undefined = best; key != null && key !== startKey; key = cameFrom.get(key)) {
    const [cx, cz] = cellOfKey(key);
    cells.push({ x: cx + 0.5, z: cz + 0.5 });
  }
  cells.reverse();

  // Pull the path taut: skip every waypoint that can be walked past directly.
  const taut: Point[] = [];
  let anchor: Point = from;
  let index = 0;
  while (index < cells.length) {
    let furthest = index;
    for (let probe = cells.length - 1; probe > index; probe--) {
      if (straightWalkable(walk, anchor, cells[probe])) {
        furthest = probe;
        break;
      }
    }
    taut.push(cells[furthest]);
    anchor = cells[furthest];
    index = furthest + 1;
  }
  return taut;
}
