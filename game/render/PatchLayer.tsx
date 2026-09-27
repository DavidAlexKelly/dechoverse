import React, { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { PatchCell } from "@/game/world/surface";
import type { HeightField } from "@/game/world/worldgen";

/**
 * The ground cover: built-up blocks, parks, woods and farmland, lying flat on
 * the terrain.
 *
 * One quad per cell of a global lattice, each corner sitting at the height of
 * the ground beneath it. Because the lattice is global rather than per-polygon,
 * neighbouring cells ask for the height at exactly the same corners and get
 * exactly the same answer — so the cover is continuous, with no cracks between
 * cells and no need for any of them to know they are neighbours.
 *
 * Corner heights are memoised across the whole layer for the same reason: every
 * interior corner is shared by four cells, and the height field is the most
 * expensive thing this touches.
 */
const LIFT_M = 0.04;

function buildPatchGeometry(
  patches: PatchCell[],
  cellSize: number,
  height: HeightField,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const corners = new Map<string, number>();
  const heightAtCorner = (cx: number, cz: number): number => {
    const key = `${cx}:${cz}`;
    let y = corners.get(key);
    if (y === undefined) {
      y = height(cx * cellSize, cz * cellSize) + LIFT_M;
      corners.set(key, y);
    }
    return y;
  };

  for (const patch of patches) {
    const { cx, cz, color } = patch;
    const x0 = cx * cellSize;
    const z0 = cz * cellSize;
    const x1 = x0 + cellSize;
    const z1 = z0 + cellSize;
    const first = positions.length / 3;

    positions.push(
      x0,
      heightAtCorner(cx, cz),
      z0,
      x1,
      heightAtCorner(cx + 1, cz),
      z0,
      x1,
      heightAtCorner(cx + 1, cz + 1),
      z1,
      x0,
      heightAtCorner(cx, cz + 1),
      z1,
    );
    for (let corner = 0; corner < 4; corner++) {
      colors.push(color[0], color[1], color[2]);
    }
    indices.push(first, first + 2, first + 1, first, first + 3, first + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  // Cheap and honest: the cover lies on ground that is nearly flat over 16 m,
  // and lighting it as if it were level keeps a block reading as one surface
  // rather than as a hundred slightly different greys.
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) {
    normals[i] = 1;
  }
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  return geometry;
}

export function PatchLayer({
  patches,
  cellSize,
  height,
}: {
  patches: PatchCell[];
  cellSize: number;
  height: HeightField;
}): React.ReactElement | null {
  const geometry = useMemo(
    () => buildPatchGeometry(patches, cellSize, height),
    [patches, cellSize, height],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);

  if (patches.length === 0) {
    return null;
  }

  return (
    <mesh geometry={geometry} frustumCulled={false}>
      <meshStandardMaterial
        vertexColors
        side={THREE.DoubleSide}
        roughness={0.96}
        metalness={0}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}
