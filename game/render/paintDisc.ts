import * as THREE from "three";

/**
 * One disc, shared by every dab of paint in the game.
 *
 * Radius one, so a dab's radius is pure instance scale.
 */
export const DISC_GEOMETRY = new THREE.CircleGeometry(1, 12);

/** White, so the per-instance colour comes through unmodified. */
export const DISC_MATERIAL = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0.85,
  depthWrite: false,
});
