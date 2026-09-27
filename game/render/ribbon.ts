/**
 * A strip of ground-hugging geometry along a centreline.
 *
 * Roads use this, and so do the watercourses too narrow to have been given
 * banks. Both are the same problem: a line on a map, laid on terrain that is
 * not flat, which has to follow the ground rather than float over it or
 * tunnel into it.
 *
 * Two vertices per point, offset either side along the perpendicular, with the
 * height taken from the same field the terrain mesh is built from — so the
 * strip agrees with the ground at every vertex it shares with it.
 */
import type { HeightField } from "@/game/world/worldgen";
import type { Point2 } from "@/shared/geo";

export interface Ribbon {
  points: Point2[];
  /** Full width in metres. */
  width: number;
  /** Metres above the ground. See the callers for why this is never zero. */
  lift: number;
  color: [number, number, number];
}

/**
 * Appends one ribbon to the buffers being built for a mesh.
 *
 * Buffers rather than a geometry per ribbon: a thousand separate meshes would
 * be a thousand draw calls for something the fog eats at 500 m.
 */
export function addRibbon(
  ribbon: Ribbon,
  height: HeightField,
  positions: number[],
  colors: number[],
  indices: number[],
): void {
  const { points, width, lift, color } = ribbon;
  const half = width / 2;
  const first = positions.length / 3;

  for (let i = 0; i < points.length; i++) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];

    // The direction through this point rather than of one segment, so the
    // ribbon turns a corner as a join instead of two overlapping rectangles
    // with a notch on the outside of the bend.
    let dx = next.x - previous.x;
    let dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;

    const point = points[i];
    const y = height(point.x, point.z) + lift;

    // Perpendicular in the ground plane.
    positions.push(point.x + dz * half, y, point.z - dx * half);
    positions.push(point.x - dz * half, y, point.z + dx * half);
    colors.push(color[0], color[1], color[2], color[0], color[1], color[2]);
  }

  for (let i = 0; i + 1 < points.length; i++) {
    const a = first + i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

/**
 * Normals pointing straight up, one per vertex.
 *
 * Rather than computed from the winding: a ribbon two vertices wide has no
 * reliable winding once it doubles back on itself, and a road that turns north
 * would light as if it faced the ground. These surfaces lie flat on the
 * ground, so up is both the simplest answer and very nearly the true one.
 */
export function upwardNormals(positions: number[]): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) {
    normals[i] = 1;
  }
  return normals;
}
