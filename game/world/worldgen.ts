/**
 * Procedural terrain for DechoWorld.
 *
 * Everything here is a pure function of world coordinates and a fixed seed, so
 * every player generates an identical landscape with nothing stored and
 * nothing synchronised. That also means the same function can be used for the
 * mesh, for the player's footing and for placing anything on the ground — if
 * those ever disagreed, players would float or sink.
 *
 * No Math.random anywhere: it would give every client a different world.
 */
import type { Crater, FlatPad } from "@/game/domain/types";

const SEED = 20260826;

/** Metres across one terrain chunk. */
export const CHUNK_SIZE = 64;
/** Grid resolution within a chunk. Higher looks smoother and costs more. */
export const CHUNK_SEGMENTS = 24;
/** Chunks kept loaded in each direction around the player. */
export const VIEW_RADIUS_CHUNKS = 3;
/** Everything below this is underwater. */
export const SEA_LEVEL = 0;

/**
 * Ground height at a world position, before anything has been dug or levelled.
 *
 * A parameter rather than a constant because there are now two worlds: the
 * procedural one below, and DechoWorld 2, whose ground comes from a real DEM
 * read out of Foundry. Everything downstream — the mesh, the footing, the
 * digging and levelling — works the same way against either, so they take the
 * field rather than importing one.
 */
export type HeightField = (x: number, z: number) => number;

/** Deterministic hash of an integer lattice point, returned in 0..1. */
function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(SEED, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smoothstep, so interpolated noise has no visible grid creases. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear value noise on the integer lattice. */
export function valueNoise(x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fz = smooth(z - z0);

  const n00 = hash2(x0, z0);
  const n10 = hash2(x0 + 1, z0);
  const n01 = hash2(x0, z0 + 1);
  const n11 = hash2(x0 + 1, z0 + 1);

  const top = n00 + (n10 - n00) * fx;
  const bottom = n01 + (n11 - n01) * fx;
  return top + (bottom - top) * fz;
}

/** Fractal noise: a few octaves of value noise at halving amplitude. */
export function fbm(x: number, z: number, octaves: number): number {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let normalisation = 0;

  for (let octave = 0; octave < octaves; octave++) {
    total += valueNoise(x * frequency, z * frequency) * amplitude;
    normalisation += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / normalisation;
}

/**
 * Ground height in metres at a world position. The single source of truth for
 * terrain: mesh vertices, the player's footing and remote avatars all use it.
 */
export function heightAt(x: number, z: number): number {
  // Broad landmass shape, then hills, then mountains, then roughness.
  const continent = fbm(x * 0.0022, z * 0.0022, 4);
  const hills = fbm(x * 0.011, z * 0.011, 3);
  const detail = fbm(x * 0.05, z * 0.05, 2);

  const base = (continent - 0.42) * 42;
  const relief = (hills - 0.5) * 18;
  const roughness = (detail - 0.5) * 1.8;

  /**
   * Mountains come from a separate mask, and only the top of its range counts.
   * Raising that to a power makes high ground rare and steep rather than
   * lifting the whole landscape — so most of the world stays walkable plains
   * while a few ranges climb far above the snow line.
   */
  const mountainMask = fbm(x * 0.0034, z * 0.0034, 3);
  const ridge = Math.max(0, mountainMask - 0.54) / 0.46;
  const mountains = Math.pow(ridge, 1.9) * 170;

  const height = base + relief + mountains + roughness;

  // Flatten the sea bed so shallows read as beaches rather than cliffs.
  return height < SEA_LEVEL ? SEA_LEVEL - Math.sqrt(SEA_LEVEL - height) * 1.4 : height;
}

/**
 * How much has been dug away at a point.
 *
 * Craters are smooth bowls that sum, so digging the same spot repeatedly makes
 * a deeper hole and neighbouring digs merge into a trench rather than leaving
 * ridges between them.
 */
export function craterDepthAt(x: number, z: number, craters: Crater[]): number {
  let total = 0;
  for (const crater of craters) {
    const dx = x - crater.x;
    const dz = z - crater.z;
    const distanceSquared = dx * dx + dz * dz;
    const radiusSquared = crater.radius * crater.radius;
    if (distanceSquared >= radiusSquared) {
      continue;
    }
    const falloff = 1 - distanceSquared / radiusSquared;
    total += crater.depth * falloff * falloff;
  }
  return total;
}

/** Fraction of a pad's radius that is fully level; the rest blends out. */
const PAD_CORE = 0.65;

/**
 * Pulls the ground toward each pad's level.
 *
 * The outer band blends rather than cutting, so a levelled patch meets the
 * hillside as a slope instead of a cliff, and overlapping pads merge into one
 * plateau.
 */
export function flattenAt(x: number, z: number, natural: number, pads: FlatPad[]): number {
  let height = natural;
  for (const pad of pads) {
    const distance = Math.hypot(x - pad.x, z - pad.z);
    if (distance >= pad.radius) {
      continue;
    }
    const core = pad.radius * PAD_CORE;
    const weight = distance <= core ? 1 : smooth(1 - (distance - core) / (pad.radius - core));
    height += (pad.level - height) * weight;
  }
  return height;
}

/**
 * Ground height including everything done to it. This — not heightAt — is what
 * the mesh, the player's footing and remote avatars must all use, or players
 * will float over their own holes and levelled ground.
 *
 * Order matters: levelling applies to the natural hillside, and digging then
 * cuts into whatever that produced.
 */
export function sampleHeight(
  x: number,
  z: number,
  craters: Crater[],
  pads: FlatPad[] = [],
  base: HeightField = heightAt,
): number {
  return flattenAt(x, z, base(x, z), pads) - craterDepthAt(x, z, craters);
}

/** Pads that can affect a square patch, for per-chunk work. */
export function padsNear(
  pads: FlatPad[],
  centreX: number,
  centreZ: number,
  halfExtent: number,
): FlatPad[] {
  return pads.filter(
    (pad) =>
      Math.abs(pad.x - centreX) < halfExtent + pad.radius &&
      Math.abs(pad.z - centreZ) < halfExtent + pad.radius,
  );
}

/** Craters that can affect a square patch, for per-chunk work. */
export function cratersNear(
  craters: Crater[],
  centreX: number,
  centreZ: number,
  halfExtent: number,
): Crater[] {
  return craters.filter(
    (crater) =>
      Math.abs(crater.x - centreX) < halfExtent + crater.radius &&
      Math.abs(crater.z - centreZ) < halfExtent + crater.radius,
  );
}

/** Side of one bucket in the edit index, in metres. */
const EDIT_CELL_SIZE = 8;

interface EditBucket {
  craters: Crater[];
  pads: FlatPad[];
}

function editCellKey(cellX: number, cellZ: number): string {
  return `${cellX}:${cellZ}`;
}

/**
 * Ground height including every edit, but only consulting the edits that can
 * actually reach the point being sampled.
 *
 * sampleHeight walks the whole crater and pad list per call, which is fine for
 * building a chunk — that happens once and the result is cached — but the
 * player's footing calls it around two hundred times a frame, five samples per
 * collision probe over a dozen substeps on two axes. In a well dug room that
 * was tens of thousands of distance tests every frame, growing with every hole
 * anyone had ever made.
 *
 * Edits are small — a crater is 2.2 m across, a pad 3 m — so bucketing them by
 * position makes a sample a map lookup plus the handful of edits nearby. An
 * edit is filed under every cell its radius touches, so a lookup on the cell
 * containing the point cannot miss one that reaches it, and the answer is
 * identical to sampleHeight's.
 */
export function buildTerrainSampler(
  craters: Crater[],
  pads: FlatPad[],
  base: HeightField = heightAt,
): HeightField {
  // An untouched world is the common case, and needs no index at all.
  if (craters.length === 0 && pads.length === 0) {
    return base;
  }

  const index = new Map<string, EditBucket>();

  const bucketAt = (cellX: number, cellZ: number): EditBucket => {
    const key = editCellKey(cellX, cellZ);
    let bucket = index.get(key);
    if (bucket == null) {
      bucket = { craters: [], pads: [] };
      index.set(key, bucket);
    }
    return bucket;
  };

  const fileEdit = (
    x: number,
    z: number,
    radius: number,
    place: (bucket: EditBucket) => void,
  ): void => {
    const minX = Math.floor((x - radius) / EDIT_CELL_SIZE);
    const maxX = Math.floor((x + radius) / EDIT_CELL_SIZE);
    const minZ = Math.floor((z - radius) / EDIT_CELL_SIZE);
    const maxZ = Math.floor((z + radius) / EDIT_CELL_SIZE);
    for (let cellX = minX; cellX <= maxX; cellX++) {
      for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
        place(bucketAt(cellX, cellZ));
      }
    }
  };

  for (const crater of craters) {
    fileEdit(crater.x, crater.z, crater.radius, (bucket) => bucket.craters.push(crater));
  }
  for (const pad of pads) {
    fileEdit(pad.x, pad.z, pad.radius, (bucket) => bucket.pads.push(pad));
  }

  return (x: number, z: number): number => {
    const natural = base(x, z);
    const bucket = index.get(
      editCellKey(Math.floor(x / EDIT_CELL_SIZE), Math.floor(z / EDIT_CELL_SIZE)),
    );
    if (bucket == null) {
      return natural;
    }
    // Same order as sampleHeight: levelling applies to the natural hillside,
    // and digging then cuts into whatever that produced.
    return flattenAt(x, z, natural, bucket.pads) - craterDepthAt(x, z, bucket.craters);
  };
}

/** Palette bands, low to high. */
export const SAND: [number, number, number] = [0.85, 0.78, 0.55];
export const GRASS: [number, number, number] = [0.36, 0.6, 0.29];
export const GRASS_DARK: [number, number, number] = [0.27, 0.48, 0.24];
export const ROCK: [number, number, number] = [0.45, 0.43, 0.42];
export const SNOW: [number, number, number] = [0.92, 0.93, 0.95];

export function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/**
 * Vertex colour for a point, banded by height with a little noise so the
 * transitions are ragged rather than perfect contour lines.
 */
export function colorAt(x: number, z: number, height: number): [number, number, number] {
  // A few metres of noise on the band edges, so the snow line and shoreline
  // are ragged rather than perfect contours.
  const jitter = (valueNoise(x * 0.08, z * 0.08) - 0.5) * 5;
  const h = height + jitter;

  if (h < 1.5) {
    return mix(SAND, GRASS, (h - 0.2) / 1.6);
  }
  if (h < 26) {
    return mix(GRASS, GRASS_DARK, (h - 1.5) / 24.5);
  }
  if (h < 60) {
    return mix(GRASS_DARK, ROCK, (h - 26) / 34);
  }
  // Snow only on the true peaks. Sampled over ~25 km² this covers about 0.6%
  // of land, against peaks reaching ~110 m, so caps stay a rarity.
  return mix(ROCK, SNOW, (h - 78) / 22);
}
