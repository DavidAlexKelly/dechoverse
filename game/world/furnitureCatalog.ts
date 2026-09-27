import { footprintOf } from "@/foundry/models";
import type { FurnitureKind, PlacedObject } from "@/game/domain/types";
import type { Obstacle } from "@/game/world/collision";

export const MODEL_KIND_PREFIX = "model:";

/** The kind stored on a mark for a model at this path. */
export function modelKind(path: string): string {
  return `${MODEL_KIND_PREFIX}${path}`;
}

/** The model path a kind refers to, or null if it is not a model. */
export function modelPathOf(kind: string): string | null {
  return kind.startsWith(MODEL_KIND_PREFIX) ? kind.slice(MODEL_KIND_PREFIX.length) : null;
}

/**
 * Create modes that deform the ground, and so only mean anything where there
 * is ground to deform.
 *
 * Building blocks is deliberately not in here. A cube is an object placed in
 * the world rather than a change to the terrain, so it works anywhere — only
 * digging, levelling and putting the ground back need a terrain mesh, and the
 * flat rooms draw none, so there they would write marks nothing could render.
 *
 * Kept here rather than in CreatePicker so the picker file exports only its
 * component, which is what fast refresh needs.
 */
const TERRAIN_MODES = new Set(["dig", "flatten", "restore"]);

export function needsTerrain(mode: string): boolean {
  return TERRAIN_MODES.has(mode);
}

/** Kinds are stored in the mark stream's `kind` column, so validate on read. */
export function isFurnitureKind(value: unknown): value is FurnitureKind {
  if (typeof value !== "string") {
    return false;
  }
  return value === "chair" || value === "table" || value.startsWith(MODEL_KIND_PREFIX);
}

/** Everything is drawn and collided at this scale. */
export const FURNITURE_SCALE = 1.2;

/**
 * Half extents of the two hand-built shapes, before scaling, in metres. Kept
 * for chairs and tables already standing in the world; nothing places new
 * ones now that the model pack covers furniture.
 */
const FOOTPRINTS: Record<string, { halfX: number; halfZ: number }> = {
  chair: { halfX: 0.25, halfZ: 0.25 },
  table: { halfX: 0.62, halfZ: 0.42 },
};

/**
 * Turns a placed prop into the box used for collision.
 *
 * Model props are measured from their own geometry once loaded, so a
 * toothbrush is not as solid as a wardrobe. Until then footprintOf returns a
 * default; anything depending on this re-derives when the load completes.
 *
 * Models also carry a height, so a low prop can be stepped or jumped over
 * instead of being a floor-to-ceiling wall the way the built-ins are.
 */
export function obstacleFor(object: PlacedObject): Obstacle {
  const path = modelPathOf(object.kind);
  if (path != null) {
    const footprint = footprintOf(path);
    return {
      x: object.position[0],
      z: object.position[2],
      yaw: object.yaw,
      halfX: footprint.halfX,
      halfZ: footprint.halfZ,
      yMin: object.position[1],
      yMax: object.position[1] + footprint.height,
    };
  }

  const footprint = FOOTPRINTS[object.kind] ?? FOOTPRINTS.chair;
  return {
    x: object.position[0],
    z: object.position[2],
    yaw: object.yaw,
    halfX: footprint.halfX * FURNITURE_SCALE,
    halfZ: footprint.halfZ * FURNITURE_SCALE,
  };
}
