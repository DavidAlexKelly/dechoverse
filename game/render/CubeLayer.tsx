import React, { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Cube } from "@/game/domain/types";
import { capacityFor } from "@/game/render/instancing";
import { CUBE_SIZE } from "@/game/world/voxels";

/**
 * Built cubes, drawn as a single instanced mesh.
 *
 * Shootable so you can stack onto them and erase them, but with no targetId,
 * so the select tool ignores them.
 *
 * A builder can place a lot of these — DechoWorld is already past a thousand —
 * and a mesh each meant a draw call each. One InstancedMesh draws the lot in
 * one call, with the colour riding in the instance buffer rather than in a
 * material per colour.
 */
/**
 * Per-face brightness, in BoxGeometry's own side order: +X, -X, +Y, -Y, +Z, -Z.
 *
 * Opposite faces are deliberately given slightly different values. Matching
 * them makes a cube read as a flat symmetric shape from most angles, which is
 * the main reason untextured blocks of a single colour look two dimensional.
 */
const FACE_SHADE = [0.8, 0.72, 1, 0.5, 0.86, 0.66];

/**
 * The shared cube geometry, with the face shading baked in as vertex colours.
 *
 * BoxGeometry lays its six sides out in a fixed order with four vertices
 * each, so writing the colour attribute once here applies to every cube of
 * every colour at no runtime cost. Three multiplies material colour by vertex
 * colour by instance colour, so these are pure shade factors rather than
 * colours in their own right, and the cube's own colour arrives per instance.
 *
 * This matters because ambient and hemisphere light cannot distinguish the
 * four vertical faces of a cube from one another, and a single directional
 * light only separates the ones facing it from the ones facing away.
 */
function shadedCubeGeometry(): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
  const vertexCount = geometry.attributes.position.count;
  const perFace = vertexCount / FACE_SHADE.length;
  const colors = new Float32Array(vertexCount * 3);

  for (let index = 0; index < vertexCount; index++) {
    const shade = FACE_SHADE[Math.floor(index / perFace)];
    colors[index * 3] = shade;
    colors[index * 3 + 1] = shade;
    colors[index * 3 + 2] = shade;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * One geometry and one material for every cube in every room, for the whole
 * session.
 *
 * These used to be rebuilt whenever the cube list changed — which is every
 * poll that lands an edit — and the discarded materials were never disposed,
 * so a long building session leaked one per colour per update.
 */
const CUBE_GEOMETRY = shadedCubeGeometry();

/**
 * Opacity is rounded to these many steps before cubes are grouped by it.
 *
 * Colour rides in the instance buffer, but opacity cannot: it belongs to the
 * material, and a material belongs to a mesh. Rounding means a room needs at
 * most eleven meshes however many shades of glass are in it, rather than one
 * per distinct value — and a twentieth of opacity is not a difference anyone
 * can see anyway.
 */
const OPACITY_STEPS = 10;

function opacityBucket(opacity: number): number {
  return Math.round(Math.max(0, Math.min(1, opacity)) * OPACITY_STEPS) / OPACITY_STEPS;
}

/** One material per opacity step, made on demand and kept for the session. */
const materials = new Map<number, THREE.MeshStandardMaterial>();

function materialFor(alpha: number): THREE.MeshStandardMaterial {
  const existing = materials.get(alpha);
  if (existing != null) {
    return existing;
  }
  const material = new THREE.MeshStandardMaterial({
    // White, so the per-instance colour comes through unmodified.
    color: "#ffffff",
    roughness: 0.8,
    metalness: 0.05,
    flatShading: true,
    // Picks up the per-face shading baked into the shared geometry.
    vertexColors: true,
    transparent: alpha < 1,
    opacity: alpha,
    // Depth is written even when see-through, the way glass behaves: a faint
    // block still hides what is behind it rather than letting the whole world
    // sort itself through the gap.
    depthWrite: true,
  });
  materials.set(alpha, material);
  return material;
}

const matrix = new THREE.Matrix4();
const color = new THREE.Color();

/** Every cube of one opacity, in one draw call. */
function CubeBatch({ alpha, cubes }: { alpha: number; cubes: Cube[] }): React.ReactElement {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const capacity = capacityFor(cubes.length);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh == null) {
      return;
    }

    const count = Math.min(cubes.length, capacity);
    for (let index = 0; index < count; index++) {
      const cube = cubes[index];
      mesh.setMatrixAt(index, matrix.makeTranslation(cube.x, cube.y, cube.z));
      mesh.setColorAt(index, color.set(cube.color));
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor != null) {
      mesh.instanceColor.needsUpdate = true;
    }
    // Both the raycast and frustum culling test this sphere, and it is
    // computed from the instances rather than the geometry — so a stale one
    // means cubes that cannot be shot or that vanish at the screen edge.
    mesh.computeBoundingSphere();
  }, [cubes, capacity]);

  return (
    <instancedMesh
      // Capacity is fixed at construction, so crossing a block boundary has to
      // rebuild the mesh. Every placement in between just rewrites the buffer.
      key={capacity}
      ref={meshRef}
      args={[CUBE_GEOMETRY, materialFor(alpha), capacity]}
      userData={{ shootable: true }}
    />
  );
}

export function CubeLayer({ cubes }: { cubes: Cube[] }): React.ReactElement {
  const batches = useMemo(() => {
    const byOpacity = new Map<number, Cube[]>();
    for (const cube of cubes) {
      const alpha = opacityBucket(cube.opacity);
      const batch = byOpacity.get(alpha);
      if (batch == null) {
        byOpacity.set(alpha, [cube]);
      } else {
        batch.push(cube);
      }
    }
    // Most solid first. Three sorts transparent objects behind the scenes
    // anyway, but a stable order keeps the meshes from being rebuilt as the
    // set of opacities in the room changes.
    return [...byOpacity.entries()].sort((a, b) => b[0] - a[0]);
  }, [cubes]);

  return (
    <group>
      {batches.map(([alpha, batch]) => (
        <CubeBatch key={alpha} alpha={alpha} cubes={batch} />
      ))}
    </group>
  );
}
