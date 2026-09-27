import { type Point, findPath } from "@/agents/body/pathing";
import type { LevelGeometry } from "@/agents/world/levels";
import { angleDelta } from "@/shared/angles";
import {
  EYE_HEIGHT,
  PLAYER_RADIUS,
  type VoxelWorld,
  floorUnder,
  sweepHorizontal,
  sweepVertical,
} from "@/game/world/collision";

/**
 * An AI player's body: where it stands, which way it faces, and how it walks.
 *
 * Moves with exactly the swept collision a human walks with — collision.ts,
 * unchanged — so an agent is stopped by the same cubes, climbs the same
 * slopes and falls off the same edges. Nothing here decides anything; it
 * goes where it is told and reports whether it is getting there.
 */

/** Slower than a human's 3.5 m/s: an unhurried walk reads as a resident, not a bot. */
const WALK_SPEED = 2.2;
/** Radians per second. */
const TURN_RATE = 4;
/** Matches Player.tsx. */
const GRAVITY = 22;
/** Close enough to a waypoint to move on to the next. */
const WAYPOINT_REACHED = 0.45;
/** Managing less than this fraction of walking speed counts as not moving. */
const STALL_FRACTION = 0.25;

export interface EyePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vz: number;
}

/**
 * Heading that faces from one point towards another, in the camera
 * convention presence uses: yaw 0 looks down -Z.
 */
export function yawTowards(from: Point, to: Point): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

export class Body {
  x: number;
  z: number;
  feetY: number;
  yaw = 0;
  pitch = 0;
  vx = 0;
  vz = 0;
  /** Seconds spent trying to walk without getting anywhere. */
  stalledFor = 0;

  private velocityY = 0;
  private grounded = true;
  private path: Point[] = [];
  private facing: Point | null = null;
  private arriveWithin = WAYPOINT_REACHED;
  private destination: Point | null = null;

  constructor(
    spawn: Point,
    private readonly geometry: LevelGeometry,
    world: VoxelWorld,
  ) {
    this.x = spawn.x;
    this.z = spawn.z;
    this.feetY = world.terrainAt(spawn.x, spawn.z);
  }

  /** True while there is somewhere left to walk. */
  get moving(): boolean {
    return this.path.length > 0;
  }

  get target(): Point | null {
    return this.destination;
  }

  distanceTo(point: Point): number {
    return Math.hypot(point.x - this.x, point.z - this.z);
  }

  /**
   * Plans a walk to within `within` metres of a point. False when no way was
   * found, in which case the body stays put.
   */
  goTo(world: VoxelWorld, to: Point, within: number = WAYPOINT_REACHED): boolean {
    if (this.distanceTo(to) <= within) {
      this.stop();
      return true;
    }
    const path = findPath(world, this.geometry, { x: this.x, z: this.z }, to);
    if (path == null || path.length === 0) {
      this.stop();
      return false;
    }
    this.path = path;
    this.destination = to;
    this.arriveWithin = within;
    this.stalledFor = 0;
    return true;
  }

  stop(): void {
    this.path = [];
    this.destination = null;
  }

  /** Turn to look at a point while standing still. Walking overrides it. */
  lookAt(point: Point | null): void {
    this.facing = point;
  }

  /** Advances the body by `dt` seconds. */
  step(dt: number, world: VoxelWorld): void {
    // A throttled background tab can deliver a second at once; walk it in
    // pieces rather than teleporting through a wall.
    const slice = Math.min(dt, 0.1);
    for (let remaining = dt; remaining > 1e-6; remaining -= slice) {
      this.advance(Math.min(slice, remaining), world);
    }
  }

  private advance(dt: number, world: VoxelWorld): void {
    let wishX = 0;
    let wishZ = 0;
    let heading: number | null = null;

    // Drop waypoints already reached; finish when the destination is close enough.
    while (this.path.length > 0) {
      const next = this.path[0];
      const last = this.path.length === 1;
      const reach = last ? this.arriveWithin : WAYPOINT_REACHED;
      if (this.distanceTo(next) > reach && !(last && this.destination != null && this.distanceTo(this.destination) <= this.arriveWithin)) {
        break;
      }
      this.path.shift();
      if (this.path.length === 0) {
        this.destination = null;
      }
    }

    if (this.path.length > 0) {
      const next = this.path[0];
      const distance = this.distanceTo(next);
      heading = yawTowards({ x: this.x, z: this.z }, next);
      const speed = Math.min(WALK_SPEED * dt, distance);
      wishX = ((next.x - this.x) / distance) * speed;
      wishZ = ((next.z - this.z) / distance) * speed;
    } else if (this.facing != null && this.distanceTo(this.facing) > 0.1) {
      heading = yawTowards({ x: this.x, z: this.z }, this.facing);
    }

    if (heading != null) {
      const turn = angleDelta(this.yaw, heading);
      const maxTurn = TURN_RATE * dt;
      this.yaw += Math.max(-maxTurn, Math.min(maxTurn, turn));
    }

    const before = { x: this.x, z: this.z };
    if (wishX !== 0 || wishZ !== 0) {
      const moved = sweepHorizontal(world, { x: this.x, z: this.z, feetY: this.feetY }, wishX, wishZ);
      this.x = moved.x;
      this.z = moved.z;
      this.feetY = moved.feetY;
    }
    this.clampToRoom();

    this.velocityY -= GRAVITY * dt;
    if (this.grounded) {
      // Stay glued to the ground walking downhill rather than hopping.
      const floor = floorUnder(world, this.x, this.feetY, this.z);
      if (floor < this.feetY && this.feetY - floor < 0.6) {
        this.feetY = floor;
        this.velocityY = 0;
      }
    }
    const vertical = sweepVertical(
      world,
      { x: this.x, z: this.z, feetY: this.feetY },
      { feetY: this.feetY, velocity: this.velocityY, grounded: this.grounded },
      dt,
    );
    this.feetY = vertical.feetY;
    this.velocityY = vertical.velocity;
    this.grounded = vertical.grounded;

    this.vx = (this.x - before.x) / dt;
    this.vz = (this.z - before.z) / dt;

    const wanted = Math.hypot(wishX, wishZ);
    const achieved = Math.hypot(this.x - before.x, this.z - before.z);
    if (wanted > 0 && achieved < wanted * STALL_FRACTION) {
      this.stalledFor += dt;
    } else if (wanted > 0) {
      this.stalledFor = Math.max(0, this.stalledFor - dt);
    }
  }

  private clampToRoom(): void {
    const half = this.geometry.halfSize;
    if (half == null) {
      return;
    }
    const limit = half - PLAYER_RADIUS;
    this.x = Math.max(-limit, Math.min(limit, this.x));
    this.z = Math.max(-limit, Math.min(limit, this.z));
  }

  /** The pose as presence carries it: eye height, not feet. */
  eyePose(): EyePose {
    return {
      x: this.x,
      y: this.feetY + EYE_HEIGHT,
      z: this.z,
      yaw: this.yaw,
      pitch: this.pitch,
      vx: this.vx,
      vz: this.vz,
    };
  }
}
