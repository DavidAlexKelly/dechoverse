/**
 * The grid placed cubes live on, and the maths for snapping to it.
 *
 * Cubes occupy fixed cells, so clicking a face puts the new cube in the empty
 * cell next to it — the Minecraft behaviour — and stacks line up exactly
 * rather than drifting with the click position.
 */
import type { Cube } from "@/game/domain/types";

/** Colour used when a record has none, and the build tool's starting colour. */
export const DEFAULT_CUBE_COLOR = "#3f4247";

/**
 * How solid a cube is when its record does not say, which is every cube placed
 * before opacity existed. Fully solid, so nothing already built changes.
 */
export const DEFAULT_CUBE_OPACITY = 1;

/**
 * Faintest a cube may be built.
 *
 * Not zero on purpose: a block nobody can see is still one you walk into, and
 * an invisible wall in a shared world is a trap rather than a building
 * material.
 */
export const MIN_CUBE_OPACITY = 0.2;

/** Edge length of one cube, in metres. */
export const CUBE_SIZE = 1;

/**
 * The cell centre a new cube should occupy, given where a surface was hit and
 * that surface's outward normal.
 *
 * Nudging along the normal before snapping is what picks the *empty* cell on
 * the near side of the face rather than the solid one behind it.
 */
export function snapToCell(
  point: { x: number; y: number; z: number },
  normal: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const nudge = CUBE_SIZE * 0.5;
  const px = point.x + normal.x * nudge;
  const py = point.y + normal.y * nudge;
  const pz = point.z + normal.z * nudge;

  return {
    x: (Math.floor(px / CUBE_SIZE) + 0.5) * CUBE_SIZE,
    y: (Math.floor(py / CUBE_SIZE) + 0.5) * CUBE_SIZE,
    z: (Math.floor(pz / CUBE_SIZE) + 0.5) * CUBE_SIZE,
  };
}

/** True when two cube centres are the same cell. */
export function sameCell(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): boolean {
  const half = CUBE_SIZE * 0.4;
  return Math.abs(a.x - b.x) < half && Math.abs(a.y - b.y) < half && Math.abs(a.z - b.z) < half;
}

/**
 * Height of the highest cube surface in the column at (x, z), or null when the
 * column is empty. Lets players walk up and stand on what they have built.
 *
 * Only the top matters: this treats a stack as solid ground rather than
 * modelling overhangs, which keeps footing a single cheap lookup.
 */
/** Grid cell containing a world coordinate on one axis. */
export function cellOf(value: number): number {
  return Math.floor(value / CUBE_SIZE);
}

export function cellKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

/**
 * Cubes indexed by cell.
 *
 * A flat array meant every footing query scanned every cube; keyed by cell,
 * "is this cell solid" is a single lookup, and walking a column is a handful
 * of them regardless of how much has been built.
 */
export function buildVoxelMap(cubes: Cube[]): Map<string, Cube> {
  const map = new Map<string, Cube>();
  for (const cube of cubes) {
    // Centres sit at cell + 0.5, so flooring recovers the cell exactly.
    map.set(cellKey(cellOf(cube.x), cellOf(cube.y), cellOf(cube.z)), cube);
  }
  return map;
}

export function hasCube(voxels: Map<string, Cube>, cx: number, cy: number, cz: number): boolean {
  return voxels.has(cellKey(cx, cy, cz));
}

/** How high a surface can be above the feet and still be stepped onto. */
export const STEP_UP = 0.35;
