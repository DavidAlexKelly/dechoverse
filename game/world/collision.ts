import type { Cube } from "@/game/domain/types";
import { CUBE_SIZE, STEP_UP, cellOf, hasCube } from "@/game/world/voxels";

/**
 * Swept collision for the player against voxels and terrain.
 *
 * The player is an axis-aligned box. Movement is applied one axis at a time
 * and in small substeps, which is what gives sliding contact along walls, no
 * corner clipping, and no tunnelling through a cube at sprint speed on a bad
 * frame. Terrain stays a height field: it can be walked up while the rise per
 * substep is within a step, and blocks when it is steeper than that.
 */

/**
 * A solid box the player cannot walk through.
 *
 * Props are turned into these by the furniture catalogue; the shape itself is
 * a physics concept, so it is declared here alongside the code that sweeps
 * against it.
 */
export interface Obstacle {
  x: number;
  z: number;
  yaw: number;
  halfX: number;
  halfZ: number;
  /**
   * Vertical extent. Omitted means "floor to ceiling", which is right for
   * furniture; cubes set it so one stacked overhead does not block the ground
   * beneath it.
   */
  yMin?: number;
  yMax?: number;
}

export const PLAYER_RADIUS = 0.35;
/** Feet to the top of the head. */
export const PLAYER_HEIGHT = 1.8;
/**
 * Feet to the camera.
 *
 * Shared with the avatars, which subtract it from the published pose to put a
 * remote player's feet on the ground their owner was standing on. The two used
 * to hold their own copies of the number and had to agree.
 */
export const EYE_HEIGHT = 1.7;
/** Longest movement resolved in one substep, in metres. */
const MAX_SUBSTEP = 0.2;
/** Cells searched up or down a column before giving up. */
const COLUMN_SEARCH = 6;
const EPS = 0.001;

export interface VoxelWorld {
  voxels: Map<string, Cube>;
  /** Ground height of the underlying terrain. */
  terrainAt: (x: number, z: number) => number;
  /**
   * Placed props, as boxes. Unlike terrain they are not a height field: they
   * have a top you can stand on and an underside you can pass beneath.
   */
  props?: Obstacle[];
}

/** True when the player's footprint overlaps a prop, tested in its own frame. */
function overlapsProp(prop: Obstacle, x: number, z: number): boolean {
  const dx = x - prop.x;
  const dz = z - prop.z;
  const cos = Math.cos(prop.yaw);
  const sin = Math.sin(prop.yaw);
  const localX = dx * cos + dz * sin;
  const localZ = -dx * sin + dz * cos;
  return (
    Math.abs(localX) < prop.halfX + PLAYER_RADIUS && Math.abs(localZ) < prop.halfZ + PLAYER_RADIUS
  );
}

/**
 * The highest prop surface under this position that is within reach of the
 * feet, or -Infinity when there is nothing to stand on.
 *
 * Reach is measured from the feet for the same reason it is for cubes: a
 * shelf above your head is not a floor.
 */
export function propTopAt(props: Obstacle[], x: number, z: number, reach: number): number {
  let best = -Infinity;
  for (const prop of props) {
    const top = prop.yMax;
    if (top == null || top > reach + EPS || top <= best) {
      continue;
    }
    if (overlapsProp(prop, x, z)) {
      best = top;
    }
  }
  return best;
}

/** Highest terrain under the player's footprint, sampled at centre and corners. */
function terrainUnder(world: VoxelWorld, x: number, z: number): number {
  const r = PLAYER_RADIUS * 0.9;
  return Math.max(
    world.terrainAt(x, z),
    world.terrainAt(x - r, z - r),
    world.terrainAt(x + r, z - r),
    world.terrainAt(x - r, z + r),
    world.terrainAt(x + r, z + r),
  );
}

/** True when the player's box at this position intersects a solid cell. */
export function blockedAt(world: VoxelWorld, x: number, feetY: number, z: number): boolean {
  const minCx = cellOf(x - PLAYER_RADIUS + EPS);
  const maxCx = cellOf(x + PLAYER_RADIUS - EPS);
  const minCz = cellOf(z - PLAYER_RADIUS + EPS);
  const maxCz = cellOf(z + PLAYER_RADIUS - EPS);
  const minCy = cellOf(feetY + EPS);
  const maxCy = cellOf(feetY + PLAYER_HEIGHT - EPS);

  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        if (hasCube(world.voxels, cx, cy, cz)) {
          return true;
        }
      }
    }
  }

  // Props block the body, except where they are low enough to step onto —
  // those become floor instead, so a book does not stop you dead.
  for (const prop of world.props ?? []) {
    if (prop.yMin == null || prop.yMax == null) {
      continue;
    }
    const steppable = prop.yMax <= feetY + STEP_UP;
    const clearsAbove = feetY >= prop.yMax - EPS;
    const clearsBelow = feetY + PLAYER_HEIGHT <= prop.yMin + EPS;
    if (steppable || clearsAbove || clearsBelow) {
      continue;
    }
    if (overlapsProp(prop, x, z)) {
      return true;
    }
  }

  // Terrain counts as blocking only when it rises more than a step.
  return terrainUnder(world, x, z) > feetY + STEP_UP;
}

/**
 * Surface the player would stand on at this position: the highest cube top
 * within stepping reach of the feet, else the terrain.
 *
 * Reach is measured from the feet, so a platform overhead is not ground — that
 * is what makes overhangs walkable.
 */
export function floorUnder(world: VoxelWorld, x: number, feetY: number, z: number): number {
  let best = terrainUnder(world, x, z);
  const reach = feetY + STEP_UP;

  const minCx = cellOf(x - PLAYER_RADIUS + EPS);
  const maxCx = cellOf(x + PLAYER_RADIUS - EPS);
  const minCz = cellOf(z - PLAYER_RADIUS + EPS);
  const maxCz = cellOf(z + PLAYER_RADIUS - EPS);
  const topCy = cellOf(reach);

  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cz = minCz; cz <= maxCz; cz++) {
      // Walk down the column: the first solid cell is the highest surface.
      for (let cy = topCy; cy > topCy - COLUMN_SEARCH; cy--) {
        if (!hasCube(world.voxels, cx, cy, cz)) {
          continue;
        }
        const top = (cy + 1) * CUBE_SIZE;
        if (top <= reach + EPS && top > best) {
          best = top;
        }
        break;
      }
    }
  }

  const propTop = propTopAt(world.props ?? [], x, z, reach);
  return propTop > best ? propTop : best;
}

/**
 * How far the floor may fall away beneath a candidate position before that
 * position counts as stepping off an edge. Half a cube, so dropping down a
 * kerb or a slope is still allowed while walking off a block is not.
 */
export const EDGE_DROP = 0.5;

/**
 * True when the player would still have something under them here.
 *
 * floorUnder already reports the highest surface anywhere beneath the
 * player's box, so a partial overhang counts as supported. That is what makes
 * edge protection feel right rather than sticky: you can stand with your toes
 * over the drop, you just cannot walk out past it.
 */
export function supportedAt(world: VoxelWorld, x: number, feetY: number, z: number): boolean {
  return floorUnder(world, x, feetY, z) >= feetY - EDGE_DROP;
}

export interface Motion {
  x: number;
  z: number;
  feetY: number;
}

/**
 * Moves horizontally, resolving each axis separately so a blocked direction
 * slides rather than stopping dead, and stepping up over small rises.
 */
export function sweepHorizontal(
  world: VoxelWorld,
  motion: Motion,
  deltaX: number,
  deltaZ: number,
): Motion {
  const distance = Math.hypot(deltaX, deltaZ);
  const steps = Math.min(12, Math.max(1, Math.ceil(distance / MAX_SUBSTEP)));
  const stepX = deltaX / steps;
  const stepZ = deltaZ / steps;

  let { x, z, feetY } = motion;

  for (let step = 0; step < steps; step++) {
    for (const axis of ["x", "z"] as const) {
      const nextX = axis === "x" ? x + stepX : x;
      const nextZ = axis === "z" ? z + stepZ : z;

      if (!blockedAt(world, nextX, feetY, nextZ)) {
        x = nextX;
        z = nextZ;
        continue;
      }

      // Blocked head-on: try again from a stepped-up stance, which is how
      // kerbs and slopes are climbed without a jump.
      const raised = feetY + STEP_UP;
      if (!blockedAt(world, nextX, raised, nextZ)) {
        x = nextX;
        z = nextZ;
        feetY = Math.min(raised, floorUnder(world, x, raised, z));
      }
    }
  }

  return { x, z, feetY };
}

export interface Vertical {
  feetY: number;
  velocity: number;
  grounded: boolean;
}

/** Applies gravity or a jump, landing on floors and stopping at ceilings. */
export function sweepVertical(
  world: VoxelWorld,
  motion: Motion,
  vertical: Vertical,
  delta: number,
): Vertical {
  let { feetY, velocity, grounded } = vertical;
  const travel = Math.abs(velocity * delta);
  const steps = Math.min(12, Math.max(1, Math.ceil(travel / MAX_SUBSTEP)));

  for (let step = 0; step < steps; step++) {
    const floor = floorUnder(world, motion.x, feetY, motion.z);

    if (velocity > 0) {
      // Rising: test the destination for blockage rather than looking for a
      // ceiling. Once the head has entered a cube's cell, "what is above me"
      // no longer sees that cube — testing the box itself cannot miss it.
      const next = feetY + (velocity * delta) / steps;
      if (blockedAt(world, motion.x, next, motion.z)) {
        velocity = 0;
        grounded = false;
        break;
      }
      feetY = next;
      grounded = false;
      continue;
    }

    feetY += (velocity * delta) / steps;
    if (feetY <= floor) {
      feetY = floor;
      velocity = 0;
      grounded = true;
      break;
    }
    grounded = false;
  }

  return { feetY, velocity, grounded };
}
