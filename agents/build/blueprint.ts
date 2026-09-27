/**
 * Blueprints: what a model designs, turned into cubes the game can place.
 *
 * Models describe buildings far better in shapes — "a 5×4 wall with a door
 * gap, a pitched roof" — than as eighty coordinates, so a plan is a list of
 * parts (wall, floor, box, pillar, roof, arch, clear, cube) and the game
 * expands them. The nearest safe equivalent of Mindcraft's skill library:
 * the model composes named building moves, but never runs code.
 *
 * Everything is in site coordinates: x and z are cells from the site's
 * corner (0 … size-1), y is layers above that column's ground (0 = resting
 * on it). Pure, so every shape is unit tested.
 */

export interface Cell {
  dx: number;
  dy: number;
  dz: number;
}

export interface BlueprintCube extends Cell {
  color: string;
}

export const MAX_LAYERS = 16;
/** Expansion stops here, whatever the parts say: a runaway box is not a plan. */
const MAX_EXPANDED = 3000;
const HEX = /^#[0-9a-fA-F]{6}$/;

export const SHAPE_REFERENCE = [
  'Parts, in site cells (x, z from 0 to size-1; y = layers above the ground, 0 = on it). "c" is a palette index.',
  '- {"shape":"wall","from":[x,z],"to":[x,z],"height":h,"y":0,"c":0}   straight wall, h high',
  '- {"shape":"floor","from":[x,z],"to":[x,z],"y":0,"c":0}              one flat layer',
  '- {"shape":"box","from":[x,y,z],"to":[x,y,z],"hollow":false,"c":0}   solid or hollow block',
  '- {"shape":"pillar","at":[x,z],"height":h,"y":0,"c":0}',
  '- {"shape":"roof","from":[x,z],"to":[x,z],"y":y,"style":"flat|pitched|pyramid","c":0}',
  '- {"shape":"arch","from":[x,z],"to":[x,z],"height":h,"y":0,"c":0}    two legs and a top span',
  '- {"shape":"clear","from":[x,y,z],"to":[x,y,z]}                      empties cells: doors, windows',
  '- {"shape":"cube","at":[x,y,z],"c":0}',
  "Parts apply in order, so put clear after what it cuts into. Every cube must connect to the",
  "ground through other cubes (above, below or beside) — unconnected cubes are dropped.",
].join("\n");

export function cellKey(cell: Cell): string {
  return `${cell.dx},${cell.dy},${cell.dz}`;
}

function int(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const a = int(value[0]);
  const b = int(value[1]);
  return a == null || b == null ? null : [a, b];
}

function triple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) {
    return null;
  }
  const a = int(value[0]);
  const b = int(value[1]);
  const c = int(value[2]);
  return a == null || b == null || c == null ? null : [a, b, c];
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  const step = a <= b ? 1 : -1;
  for (let v = a; step > 0 ? v <= b : v >= b; v += step) {
    out.push(v);
    if (out.length > 64) {
      break;
    }
  }
  return out;
}

/** Cells on a straight line between two points, Bresenham style. */
function line(from: [number, number], to: [number, number]): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  let [x, z] = from;
  const [x1, z1] = to;
  const dx = Math.abs(x1 - x);
  const dz = -Math.abs(z1 - z);
  const sx = x < x1 ? 1 : -1;
  const sz = z < z1 ? 1 : -1;
  let error = dx + dz;
  for (let guard = 0; guard < 128; guard++) {
    cells.push([x, z]);
    if (x === x1 && z === z1) {
      break;
    }
    const doubled = 2 * error;
    if (doubled >= dz) {
      error += dz;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      z += sz;
    }
  }
  return cells;
}

export interface Expansion {
  /** Cells to fill, keyed by cell, each with its palette colour. */
  cubes: Map<string, BlueprintCube>;
  /** Cells a clear part emptied, including ones that were never filled here. */
  cleared: Set<string>;
}

/**
 * Expands parts into cells. Unknown shapes and malformed parts are skipped
 * rather than failing the whole plan; a colour index outside the palette
 * falls back to the first colour.
 */
export function expandParts(parts: unknown[], palette: string[]): Expansion {
  const cubes = new Map<string, BlueprintCube>();
  const cleared = new Set<string>();
  const colourOf = (part: Record<string, unknown>): string => {
    const index = int(part.c ?? part.color ?? 0) ?? 0;
    return palette[index] ?? palette[0];
  };
  const put = (dx: number, dy: number, dz: number, color: string): void => {
    if (cubes.size >= MAX_EXPANDED) {
      return;
    }
    const cell = { dx, dy, dz };
    cubes.set(cellKey(cell), { ...cell, color });
    cleared.delete(cellKey(cell));
  };

  for (const raw of parts) {
    if (raw == null || typeof raw !== "object") {
      continue;
    }
    const part = raw as Record<string, unknown>;
    const color = colourOf(part);
    const y0 = int(part.y) ?? 0;
    const height = Math.max(1, Math.min(MAX_LAYERS, int(part.height) ?? 1));

    switch (part.shape) {
      case "cube": {
        const at = triple(part.at);
        if (at != null) {
          put(at[0], at[1], at[2], color);
        }
        break;
      }
      case "pillar": {
        const at = pair(part.at);
        if (at != null) {
          for (let dy = 0; dy < height; dy++) {
            put(at[0], y0 + dy, at[1], color);
          }
        }
        break;
      }
      case "wall": {
        const from = pair(part.from);
        const to = pair(part.to);
        if (from != null && to != null) {
          for (const [x, z] of line(from, to)) {
            for (let dy = 0; dy < height; dy++) {
              put(x, y0 + dy, z, color);
            }
          }
        }
        break;
      }
      case "floor": {
        const from = pair(part.from);
        const to = pair(part.to);
        if (from != null && to != null) {
          for (const x of range(from[0], to[0])) {
            for (const z of range(from[1], to[1])) {
              put(x, y0, z, color);
            }
          }
        }
        break;
      }
      case "box": {
        const from = triple(part.from);
        const to = triple(part.to);
        if (from != null && to != null) {
          const xs = range(from[0], to[0]);
          const ys = range(from[1], to[1]);
          const zs = range(from[2], to[2]);
          const hollow = part.hollow === true;
          for (const x of xs) {
            for (const y of ys) {
              for (const z of zs) {
                const edge =
                  x === xs[0] || x === xs[xs.length - 1] ||
                  y === ys[0] || y === ys[ys.length - 1] ||
                  z === zs[0] || z === zs[zs.length - 1];
                if (!hollow || edge) {
                  put(x, y, z, color);
                }
              }
            }
          }
        }
        break;
      }
      case "roof": {
        const from = pair(part.from);
        const to = pair(part.to);
        if (from == null || to == null) {
          break;
        }
        let minX = Math.min(from[0], to[0]);
        let maxX = Math.max(from[0], to[0]);
        let minZ = Math.min(from[1], to[1]);
        let maxZ = Math.max(from[1], to[1]);
        const style = part.style === "pyramid" ? "pyramid" : part.style === "flat" ? "flat" : "pitched";
        // A gable runs along the longer side, so it narrows across the shorter one.
        const alongX = maxX - minX >= maxZ - minZ;
        for (let layer = 0; layer < MAX_LAYERS; layer++) {
          if (minX > maxX || minZ > maxZ) {
            break;
          }
          for (const x of range(minX, maxX)) {
            for (const z of range(minZ, maxZ)) {
              put(x, y0 + layer, z, color);
            }
          }
          if (style === "flat") {
            break;
          }
          if (style === "pyramid" || !alongX) {
            minX++;
            maxX--;
          }
          if (style === "pyramid" || alongX) {
            minZ++;
            maxZ--;
          }
        }
        break;
      }
      case "arch": {
        const from = pair(part.from);
        const to = pair(part.to);
        if (from == null || to == null) {
          break;
        }
        const span = line(from, to);
        for (const [index, [x, z]] of span.entries()) {
          const leg = index === 0 || index === span.length - 1;
          if (leg) {
            for (let dy = 0; dy < height; dy++) {
              put(x, y0 + dy, z, color);
            }
          }
          put(x, y0 + height, z, color);
        }
        break;
      }
      case "clear": {
        const from = triple(part.from) ?? triple(part.at);
        const to = triple(part.to) ?? from;
        if (from == null || to == null) {
          break;
        }
        for (const x of range(from[0], to[0])) {
          for (const y of range(from[1], to[1])) {
            for (const z of range(from[2], to[2])) {
              const key = cellKey({ dx: x, dy: y, dz: z });
              cubes.delete(key);
              cleared.add(key);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return { cubes, cleared };
}

/** Legacy flat list: [[dx, dy, dz, colourIndex], …]. */
export function cubesFromList(list: unknown[], palette: string[]): Map<string, BlueprintCube> {
  const cubes = new Map<string, BlueprintCube>();
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length < 4) {
      continue;
    }
    const [dx, dy, dz, index] = entry.map(Number);
    if (![dx, dy, dz, index].every(Number.isInteger)) {
      continue;
    }
    const color = palette[index];
    if (color == null) {
      continue;
    }
    const cell = { dx, dy, dz };
    cubes.set(cellKey(cell), { ...cell, color });
  }
  return cubes;
}

export function readPalette(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((color): color is string => typeof color === "string" && HEX.test(color)).slice(0, 6)
    : [];
}

const NEIGHBOURS: Array<[number, number, number]> = [
  [0, -1, 0],
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * The cubes that can actually be built, in the order to build them.
 *
 * Kept: inside the site and under MAX_LAYERS, and connected to the ground
 * through other cubes — above, below or beside, the way the build tool lets a
 * player stick a cube to any face. `anchors` are cells already standing
 * (a build being continued), which count as connected.
 *
 * Ordered layer by layer, and within a layer by distance from the ground
 * through the structure, so every cube touches one placed before it: an
 * arch's top is placed from the legs inwards.
 */
export function buildable(
  candidates: Iterable<BlueprintCube>,
  size: number,
  maxCubes: number,
  anchors: Set<string> = new Set(),
): { cubes: BlueprintCube[]; dropped: number } {
  const inside = new Map<string, BlueprintCube>();
  let total = 0;
  for (const cube of candidates) {
    total++;
    if (
      cube.dx < 0 || cube.dz < 0 || cube.dx >= size || cube.dz >= size ||
      cube.dy < 0 || cube.dy >= MAX_LAYERS || anchors.has(cellKey(cube))
    ) {
      continue;
    }
    inside.set(cellKey(cube), cube);
  }

  // Breadth first from the ground and from what already stands.
  const distance = new Map<string, number>();
  const queue: Array<{ cell: Cell; d: number }> = [];
  for (const cube of inside.values()) {
    if (cube.dy === 0) {
      distance.set(cellKey(cube), 0);
      queue.push({ cell: cube, d: 0 });
    }
  }
  for (const key of anchors) {
    const [dx, dy, dz] = key.split(",").map(Number);
    queue.push({ cell: { dx, dy, dz }, d: 0 });
  }
  for (let head = 0; head < queue.length; head++) {
    const { cell, d } = queue[head];
    for (const [ox, oy, oz] of NEIGHBOURS) {
      const key = cellKey({ dx: cell.dx + ox, dy: cell.dy + oy, dz: cell.dz + oz });
      const next = inside.get(key);
      if (next != null && !distance.has(key)) {
        distance.set(key, d + 1);
        queue.push({ cell: next, d: d + 1 });
      }
    }
  }

  const connected = [...inside.values()].filter((cube) => distance.has(cellKey(cube)));
  connected.sort(
    (a, b) => a.dy - b.dy || (distance.get(cellKey(a)) ?? 0) - (distance.get(cellKey(b)) ?? 0),
  );
  // A layer by layer order can still visit a cube before the neighbour it
  // hangs from (an overhang reached from above); settle those by distance.
  const ordered: BlueprintCube[] = [];
  const placed = new Set(anchors);
  const pending = [...connected];
  while (pending.length > 0 && ordered.length < maxCubes) {
    const index = pending.findIndex(
      (cube) =>
        cube.dy === 0 ||
        NEIGHBOURS.some(([ox, oy, oz]) =>
          placed.has(cellKey({ dx: cube.dx + ox, dy: cube.dy + oy, dz: cube.dz + oz })),
        ),
    );
    if (index < 0) {
      break;
    }
    const [cube] = pending.splice(index, 1);
    placed.add(cellKey(cube));
    ordered.push(cube);
  }
  return { cubes: ordered, dropped: total - ordered.length };
}

/**
 * What stands on a site, drawn as text for the model: one grid per layer,
 * a letter per palette colour, "#" for any other colour, "." for empty.
 */
export function drawSite(
  occupied: Map<string, string>,
  size: number,
  palette: string[],
): string {
  let top = -1;
  for (const key of occupied.keys()) {
    top = Math.max(top, Number(key.split(",")[1]));
  }
  if (top < 0) {
    return "(nothing built yet)";
  }
  const letters = "abcdef";
  const header = `   ${Array.from({ length: size }, (_, x) => String(x % 10)).join("")}  (x →)`;
  const blocks: string[] = [];
  for (let dy = Math.min(top + 1, MAX_LAYERS - 1); dy >= 0; dy--) {
    const rows = [`layer y=${dy}`, header];
    for (let dz = 0; dz < size; dz++) {
      let row = "";
      for (let dx = 0; dx < size; dx++) {
        const color = occupied.get(cellKey({ dx, dy, dz }));
        if (color == null) {
          row += ".";
        } else {
          const index = palette.findIndex((entry) => entry.toLowerCase() === color.toLowerCase());
          row += index >= 0 ? letters[index] : "#";
        }
      }
      rows.push(`${String(dz).padStart(2)} ${row}`);
    }
    blocks.push(rows.join("\n"));
  }
  return `z runs down each grid. Colours: ${palette
    .map((color, index) => `${letters[index]}=${color}`)
    .join(" ")}, #=someone else's colour\n\n${blocks.join("\n\n")}`;
}
