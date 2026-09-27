import type { BuildSite } from "@/agents/brain/prompts";
import type { PlannedCube } from "@/agents/brain/parse";
import type { LevelGeometry } from "@/agents/world/levels";
import type { VoxelWorld } from "@/game/world/collision";
import { CUBE_SIZE, cellOf, hasCube } from "@/game/world/voxels";

/**
 * Where an agent may build, found by game logic rather than by the model.
 *
 * The model is offered a handful of sites by key and picks one; it never
 * invents coordinates. So every site offered here is already known to be on
 * land, inside the room, level enough to build on, and empty.
 */

/** Edge length of a site in cells. Big enough for a hut, small enough to find. */
export const SITE_SIZE = 7;
/**
 * How much the ground may vary across a site, tried in order.
 *
 * Level ground first. DechoWorld is hilly, though, and a strict limit finds
 * nothing on most slopes — so the search relaxes rather than giving up. Each
 * column's cubes rest on that column's own ground, so a build on a slope
 * steps with it the way a hand-built wall would.
 */
const UNEVENNESS_TIERS = [1, 2.5];
/** Keep this far above the sea, so nothing is built in the surf. */
const SHORE_MARGIN = 0.4;
/** Cells above ground that must be empty for a site to count as free. */
const CLEARANCE_LAYERS = 4;
const RINGS = [7, 11, 15, 20, 26, 32];
const BEARINGS = 10;

/**
 * The cell a cube resting on this column's ground occupies.
 *
 * Mirrors the build tool: a click on the ground at height h snaps to the cell
 * containing h + half a cube, so an agent's cube sits exactly where a human's
 * would, sunk slightly into a slope rather than hovering over it.
 */
export function groundCell(world: VoxelWorld, cellX: number, cellZ: number): number {
  const h = world.terrainAt((cellX + 0.5) * CUBE_SIZE, (cellZ + 0.5) * CUBE_SIZE);
  return cellOf(h + CUBE_SIZE * 0.5);
}

/** World-space centre of a planned cube on a site. */
export function cubeCentre(
  world: VoxelWorld,
  site: BuildSite,
  cube: Pick<PlannedCube, "dx" | "dy" | "dz">,
): { x: number; y: number; z: number } {
  const cellX = site.cellX + cube.dx;
  const cellZ = site.cellZ + cube.dz;
  const cellY = groundCell(world, cellX, cellZ) + cube.dy;
  return {
    x: (cellX + 0.5) * CUBE_SIZE,
    y: (cellY + 0.5) * CUBE_SIZE,
    z: (cellZ + 0.5) * CUBE_SIZE,
  };
}

function propOverlaps(world: VoxelWorld, minX: number, minZ: number, size: number): boolean {
  for (const prop of world.props ?? []) {
    const reach = Math.max(prop.halfX, prop.halfZ);
    if (
      prop.x + reach > minX &&
      prop.x - reach < minX + size &&
      prop.z + reach > minZ &&
      prop.z - reach < minZ + size
    ) {
      return true;
    }
  }
  return false;
}

function inspect(
  world: VoxelWorld,
  geometry: LevelGeometry,
  cellX: number,
  cellZ: number,
  size: number,
  maxUnevenness: number,
): { ok: boolean; ground: number; unevenness: number } {
  if (geometry.halfSize != null) {
    const limit = geometry.halfSize - 1;
    if (cellX < -limit || cellZ < -limit || cellX + size > limit || cellZ + size > limit) {
      return { ok: false, ground: 0, unevenness: 0 };
    }
  }
  let low = Infinity;
  let high = -Infinity;
  for (let dx = 0; dx < size; dx++) {
    for (let dz = 0; dz < size; dz++) {
      const h = world.terrainAt(cellX + dx + 0.5, cellZ + dz + 0.5);
      low = Math.min(low, h);
      high = Math.max(high, h);
      if (geometry.seaLevel != null && h < geometry.seaLevel + SHORE_MARGIN) {
        return { ok: false, ground: h, unevenness: 0 };
      }
      const base = groundCell(world, cellX + dx, cellZ + dz);
      for (let layer = -1; layer < CLEARANCE_LAYERS; layer++) {
        if (hasCube(world.voxels, cellX + dx, base + layer, cellZ + dz)) {
          return { ok: false, ground: h, unevenness: 0 };
        }
      }
    }
  }
  const unevenness = high - low;
  if (unevenness > maxUnevenness || propOverlaps(world, cellX, cellZ, size)) {
    return { ok: false, ground: low, unevenness };
  }
  return { ok: true, ground: (low + high) / 2, unevenness };
}

/**
 * Up to `count` free sites around a point, nearest rings first, no two
 * overlapping. `describe` names what is near a site, for the prompt.
 *
 * Tries level full-size sites first, then sloping ones, then smaller ones,
 * and stops at the first tier that finds anything — so a model is offered the
 * best ground available rather than a mix it has to tell apart.
 */
export function findBuildSites(
  world: VoxelWorld,
  geometry: LevelGeometry,
  around: { x: number; z: number },
  count: number,
  describe: (centre: { x: number; z: number }) => string,
  size: number = SITE_SIZE,
): BuildSite[] {
  const sizes = size > 5 ? [size, 5] : [size];
  for (const tierSize of sizes) {
    for (const unevenness of UNEVENNESS_TIERS) {
      const found = searchSites(world, geometry, around, count, describe, tierSize, unevenness);
      if (found.length > 0) {
        return found;
      }
    }
  }
  return [];
}

function searchSites(
  world: VoxelWorld,
  geometry: LevelGeometry,
  around: { x: number; z: number },
  count: number,
  describe: (centre: { x: number; z: number }) => string,
  size: number,
  maxUnevenness: number,
): BuildSite[] {
  const found: BuildSite[] = [];
  const hereGround = world.terrainAt(around.x, around.z);
  const keys = "abcdefgh";

  for (const radius of RINGS) {
    for (let bearing = 0; bearing < BEARINGS; bearing++) {
      if (found.length >= count) {
        return found;
      }
      const angle = (bearing / BEARINGS) * Math.PI * 2 + radius * 0.37;
      const centreX = around.x + Math.cos(angle) * radius;
      const centreZ = around.z + Math.sin(angle) * radius;
      const cellX = cellOf(centreX) - Math.floor(size / 2);
      const cellZ = cellOf(centreZ) - Math.floor(size / 2);

      const clash = found.some(
        (site) =>
          cellX < site.cellX + site.size + 1 &&
          site.cellX < cellX + size + 1 &&
          cellZ < site.cellZ + site.size + 1 &&
          site.cellZ < cellZ + size + 1,
      );
      if (clash) {
        continue;
      }
      const { ok, ground, unevenness } = inspect(world, geometry, cellX, cellZ, size, maxUnevenness);
      if (!ok) {
        continue;
      }
      const rise = ground - hereGround;
      const lie =
        rise > 3 ? "up on higher ground" : rise < -3 ? "down in a dip" : "level with you";
      const slope = unevenness > 1 ? `, on a slope (${unevenness.toFixed(1)} m fall)` : ", flat";
      const centre = { x: cellX + size / 2, z: cellZ + size / 2 };
      found.push({
        key: keys[found.length] ?? `s${found.length}`,
        cellX,
        cellZ,
        size,
        distance: Math.hypot(centre.x - around.x, centre.z - around.z),
        description: `${lie}${slope}, ${describe(centre)}`,
      });
    }
  }
  return found;
}
