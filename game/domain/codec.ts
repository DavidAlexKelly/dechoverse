/**
 * Packing for the mark stream's `points` column.
 *
 * A stroke and a sweep are each one record carrying many positions, and this
 * is how those positions are squeezed into a single string. Pure maths with no
 * platform dependency, so it lives with the domain rather than with the stream
 * client that happens to carry the result.
 */
import type { Dab } from "@/game/domain/types";

/** Most dabs carried by one stroke record; a longer press starts another. */
export const MAX_STROKE_DABS = 250;

/** Most pads carried by one sweep record; a longer sweep starts another. */
export const MAX_SWEEP_PADS = 400;

/** Numbers per dab in the encoded form: x y z, qx qy qz qw, radius. */
const DAB_STRIDE = 8;

/** Numbers per pad in the encoded form: x, z. */
const PAD_STRIDE = 2;

/** Millimetre precision is far finer than a spray disc; the rest is noise. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Decoded `points` columns, keyed by the string they came from.
 *
 * Every scene projection re-reads every mark in the room, so without this a
 * room's entire body of paint is re-parsed each time anything anywhere
 * changes — several times a second while someone is erasing. The encoded
 * string is its own cache key: identical text always decodes identically.
 *
 * The arrays handed out are shared, so callers must treat them as read only.
 */
const dabCache = new Map<string, Dab[]>();
const padCache = new Map<string, Array<[number, number]>>();
/** Generous: a room's worth of strokes is a few hundred entries. */
const DECODE_CACHE_LIMIT = 4000;

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= DECODE_CACHE_LIMIT) {
    // Maps iterate in insertion order, so this drops the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest != null) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
  return value;
}

/**
 * Packs a stroke's dabs into one string for the `points` column.
 *
 * A flat comma separated list with a fixed stride, rather than JSON: the same
 * numbers without the punctuation, which matters when a single record can
 * hold a couple of hundred dabs.
 */
export function encodeDabs(dabs: Dab[]): string {
  const parts: number[] = [];
  for (const dab of dabs) {
    parts.push(
      round(dab.position[0]),
      round(dab.position[1]),
      round(dab.position[2]),
      round(dab.quaternion[0]),
      round(dab.quaternion[1]),
      round(dab.quaternion[2]),
      round(dab.quaternion[3]),
      round(dab.radius),
    );
  }
  return parts.join(",");
}

/** Unpacks the `points` column. Returns an empty list for anything malformed. */
export function decodeDabs(points: string | null | undefined): Dab[] {
  if (points == null || points === "") {
    return [];
  }
  const cached = dabCache.get(points);
  if (cached != null) {
    return cached;
  }
  const parts = points.split(",");
  const dabs: Dab[] = [];
  for (let index = 0; index + DAB_STRIDE <= parts.length; index += DAB_STRIDE) {
    const values = parts.slice(index, index + DAB_STRIDE).map(Number);
    if (values.some((value) => !Number.isFinite(value))) {
      continue;
    }
    dabs.push({
      position: [values[0], values[1], values[2]],
      quaternion: [values[3], values[4], values[5], values[6]],
      radius: values[7],
    });
  }
  return remember(dabCache, points, dabs);
}

/**
 * Packs a flatten sweep's pads into the same `points` column.
 *
 * Only the position varies: every pad in a sweep shares the level being cut
 * to and the brush radius, and those ride in the record's own y and size
 * columns. Two numbers per pad rather than eight makes a sweep record much
 * smaller than a paint stroke of the same length.
 */
export function encodePads(pads: Array<[number, number]>): string {
  const parts: number[] = [];
  for (const [x, z] of pads) {
    parts.push(round(x), round(z));
  }
  return parts.join(",");
}

/** Unpacks a sweep's pads. Returns an empty list for anything malformed. */
export function decodePads(points: string | null | undefined): Array<[number, number]> {
  if (points == null || points === "") {
    return [];
  }
  const cached = padCache.get(points);
  if (cached != null) {
    return cached;
  }
  const parts = points.split(",");
  const pads: Array<[number, number]> = [];
  for (let index = 0; index + PAD_STRIDE <= parts.length; index += PAD_STRIDE) {
    const x = Number(parts[index]);
    const z = Number(parts[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      continue;
    }
    pads.push([x, z]);
  }
  return remember(padCache, points, pads);
}
