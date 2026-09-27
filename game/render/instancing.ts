/**
 * Shared helpers for the instanced layers.
 *
 * Cubes, paint and strokes are all "many identical shapes differing only in
 * where they sit and what colour they are", which is exactly what instancing
 * is for: one geometry, one material, one draw call, however many there are.
 */
import * as THREE from "three";

/**
 * Instance buffers are allocated in blocks of this many.
 *
 * The count is fixed when an InstancedMesh is constructed, so growing it means
 * remounting the mesh and re-uploading everything. Rounding capacity up to a
 * block means placing a cube costs a buffer rewrite rather than a remount, and
 * only every 256th one pays for a new allocation.
 */
const CAPACITY_BLOCK = 256;

export function capacityFor(count: number): number {
  return Math.max(CAPACITY_BLOCK, Math.ceil(count / CAPACITY_BLOCK) * CAPACITY_BLOCK);
}

/**
 * Scratch objects for filling instance buffers.
 *
 * Borrowed for the duration of one synchronous write and never held on to, so
 * a single set serves every layer and a room's worth of updates costs no
 * allocations at all. Nothing here may be stored or returned.
 */
export const scratch = {
  matrix: new THREE.Matrix4(),
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  scale: new THREE.Vector3(),
  color: new THREE.Color(),
};

/**
 * Raycast implementation for things bullets pass straight through.
 *
 * Paint, strokes, tags and impact decals are decorations: the shot is meant to
 * land on the surface underneath them. They were already filtered out after
 * the fact by the `shootable` flag, but only after every one of them had been
 * tested against the ray. Refusing here skips that work, and — on three
 * versions that honour it — stops the traversal descending into the layer at
 * all.
 */
export const NEVER_RAYCAST = (
  _raycaster: THREE.Raycaster,
  _intersects: THREE.Intersection[],
): boolean => false;
