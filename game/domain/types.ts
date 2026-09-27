/**
 * Everything the world is made of, once the mark stream has been folded.
 *
 * These are the shapes the renderer draws, the physics collides against and
 * the sync hook produces — so they belong to none of those three and are
 * declared here instead. They used to live wherever they happened to be first
 * needed (paint types in a rendering file, cubes in the voxel maths, props in
 * the furniture catalogue), which meant a data hook importing its types from a
 * component.
 *
 * Nothing in here knows about three.js, React or the Platform SDK, with the
 * single exception of a decoded texture on a tag.
 */
import type * as THREE from "three";

/** One dab of spray: where it sits, how it lies on the surface, how big. */
export interface Dab {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  radius: number;
}

/**
 * A blob of spray paint stuck to a surface.
 *
 * Legacy: one record per dab, from before strokes existed. Still rendered so
 * no existing artwork disappears, but nothing writes these any more.
 */
export interface PaintBlob {
  id: string;
  position: [number, number, number];
  /** Rotation that lays the disc flat against the surface it hit. */
  quaternion: [number, number, number, number];
  radius: number;
  color: string;
}

/** One continuous press of the spray can: many dabs, one mark. */
export interface PaintStroke {
  id: string;
  color: string;
  dabs: Dab[];
}

/** An uploaded image pasted onto a surface with the tag tool. */
export interface TagDecal {
  id: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  width: number;
  height: number;
  texture: THREE.Texture;
}

/** A personal-room door placed with the MySpace tool. */
export interface PlacedDoor {
  id: string;
  /** Display name of whoever placed it; the room belongs to them. */
  userId: string;
  position: [number, number, number];
  yaw: number;
}

/** Prefix used on door target ids, so a shot can be recognised as a door. */
export const DOOR_TARGET_PREFIX = "door-";

/** A bullet decal left behind by a shot. */
export interface Impact {
  id: string;
  position: [number, number, number];
}

/**
 * A cube placed with the create tool's build mode.
 *
 * Cubes live on a fixed grid, so clicking a face puts the new cube in the
 * empty cell next to it — the Minecraft behaviour — and stacks line up exactly
 * rather than drifting with the click position.
 */
export interface Cube {
  id: string;
  /** Centre of the cube in world space. */
  x: number;
  y: number;
  z: number;
  /** Hex colour chosen when it was placed. */
  color: string;
  /** How solid it looks, 0..1. Collision does not care — glass still stops you. */
  opacity: number;
}

/** A bowl dug out of the terrain by the dig tool. */
export interface Crater {
  id: string;
  x: number;
  z: number;
  radius: number;
  depth: number;
}

/** A patch of terrain levelled to a fixed height by the flatten tool. */
export interface FlatPad {
  /** Unique per pad, so a chunk can tell when its terrain has changed. */
  id: string;
  /**
   * The mark this pad came from. A whole sweep is one record, so many pads
   * share a markId, and erasing any of them removes the lot.
   */
  markId: string;
  x: number;
  z: number;
  radius: number;
  /** Height the ground is pulled to. */
  level: number;
}

/**
 * What the create tool can place.
 *
 * Either one of the two built-in shapes, or `model:<path>` naming a GLB in
 * the [AP] Objects dataset. The prefix is what keeps model ids from colliding
 * with the other things the stream's `kind` column carries — paint, stroke,
 * tag, door, dig, flat, sweep, cube, image — without this having to keep a
 * list of them all in step.
 */
export type FurnitureKind = string;

/**
 * How a character looks: their body colour, and what they are wearing.
 *
 * One record per player in [AP] Characters, so this is the whole of a player's
 * appearance rather than a patch of it.
 */
export interface Appearance {
  /** Hex colour of the body, the name plate border and the shadow puddle. */
  color: string;
  /** Path of a hat in the wearables pack, or null for a bare head. */
  hat: string | null;
  /**
   * Hex colour tinting the hat, or null to leave it the colour it was made.
   *
   * Null rather than a default on purpose: a cowboy hat arrives brown and a
   * traffic cone arrives orange, and "as the artist made it" is a choice a
   * player should be able to keep — and get back to.
   */
  hatColor: string | null;
}

/** A placed prop, folded out of the mark stream. */
export interface PlacedObject {
  id: string;
  kind: FurnitureKind;
  position: [number, number, number];
  /** Heading in radians. */
  yaw: number;
}
