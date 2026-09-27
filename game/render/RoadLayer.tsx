import React, { useEffect, useMemo } from "react";
import * as THREE from "three";
import { addRibbon, upwardNormals } from "@/game/render/ribbon";
import type { RoadLine } from "@/game/world/surface";
import type { HeightField } from "@/game/world/worldgen";

/**
 * Roads, laid on the ground rather than floating over it.
 *
 * Each centreline becomes a ribbon draped on the terrain — see render/ribbon,
 * which the watercourses share. The whole network is one mesh, since a
 * thousand separate meshes would be a thousand draw calls for something the fog
 * eats at 500 m.
 *
 * WHY IT SITS SLIGHTLY PROUD
 * --------------------------
 * The terrain is a triangle mesh sampled every 2.67 m and the ribbon is sampled
 * every 2.5 m, so the two agree at their vertices and disagree by millimetres
 * between them — enough for the ground to show through the tarmac in stripes.
 * A few centimetres of lift plus a polygon offset settles it without the road
 * ever reading as hovering.
 */
const SURFACE_LIFT_M = 0.16;

/**
 * The kerb: a second, wider ribbon in near-black, just under the surface.
 *
 * Height rather than draw order is what keeps it underneath. Two coplanar
 * ribbons would z-fight from the far end of the street, and six centimetres is
 * enough to separate them in the depth buffer at any distance the fog leaves
 * visible while being far too little to see as a step.
 */
const BORDER_LIFT_M = 0.1;
const BORDER_M = 0.35;
const BORDER_COLOR: [number, number, number] = [0.07, 0.07, 0.08];

function buildRoadGeometry(roads: RoadLine[], height: HeightField): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Every kerb first, then every surface. Not for correctness — the depth
  // buffer settles that — but so the two passes over the same road do not
  // interleave, which keeps the buffers coherent.
  for (const road of roads) {
    if (road.points.length < 2) {
      continue;
    }
    addRibbon(
      {
        points: road.points,
        width: road.width + BORDER_M * 2,
        lift: BORDER_LIFT_M,
        color: BORDER_COLOR,
      },
      height,
      positions,
      colors,
      indices,
    );
  }

  for (const road of roads) {
    if (road.points.length < 2) {
      continue;
    }
    addRibbon(
      { points: road.points, width: road.width, lift: SURFACE_LIFT_M, color: road.color },
      height,
      positions,
      colors,
      indices,
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(upwardNormals(positions), 3));
  geometry.setIndex(indices);
  return geometry;
}

export function RoadLayer({
  roads,
  height,
}: {
  roads: RoadLine[];
  height: HeightField;
}): React.ReactElement | null {
  const geometry = useMemo(() => buildRoadGeometry(roads, height), [roads, height]);

  // One mesh, rebuilt only when the network or the ground changes — and the old
  // one handed back to the GPU when it does.
  useEffect(() => () => geometry.dispose(), [geometry]);

  if (roads.length === 0) {
    return null;
  }

  return (
    <mesh geometry={geometry} frustumCulled={false}>
      <meshStandardMaterial
        vertexColors
        side={THREE.DoubleSide}
        roughness={0.94}
        metalness={0}
        polygonOffset
        polygonOffsetFactor={-4}
        polygonOffsetUnits={-4}
      />
    </mesh>
  );
}
