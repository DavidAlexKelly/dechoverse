import React, { useEffect, useMemo } from "react";
import * as THREE from "three";
import { addRibbon, upwardNormals } from "@/game/render/ribbon";
import type { WaterArea } from "@/game/world/surface";
import type { HeightField } from "@/game/world/worldgen";

/**
 * Rivers, canals, docks and lakes, from the basemap rather than from the DEM.
 *
 * The DEM has no water in it. GLO-90 records the sea and most lakes as VOIDS —
 * no measurement — which `geoterrain` reads as the sea floor, and a river
 * narrower than 90 m does not register at all. So the Thames arrives as a
 * shallow trough of nothing in particular, and the canals do not arrive.
 *
 * This is the other half: the basemap knows exactly where the water is,
 * because somebody drew it.
 *
 * WHY THE SURFACE IS FLAT AND THE GROUND IS NOT
 * ---------------------------------------------
 * Water is level. Draping a lake on the terrain the way a road is draped would
 * give it a surface that follows the hill it is lying on, which reads as a
 * sheet of glass tilted against gravity — the one mistake in a landscape that
 * everybody notices. So an area takes ONE height for the whole polygon: the
 * lowest ground under its outline, which is the bed rather than the bank.
 *
 * Watercourses drawn as lines are the exception. A river runs downhill, and a
 * canal steps down through locks, so those are draped like roads and keep the
 * slope of the valley they are in — visibly wrong only if you follow one for
 * kilometres, against visibly wrong immediately if the Thames were level from
 * Oxford to the sea.
 */

/**
 * Metres of water above the bed.
 *
 * Enough to cover the bank the outline was drawn on, since the DEM's idea of
 * where the bank is and the basemap's differ by a few metres, and a river that
 * sits below its own banks is a dry ditch with blue paint in it.
 */
const DEPTH_M = 1.4;

/** Watercourses sit just proud of the ground, like the roads. */
const LINE_LIFT_M = 0.18;

const WATER_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#ffffff",
  vertexColors: true,
  transparent: true,
  // Enough to read as water and to show the bed through the shallows, which is
  // the same bargain DechoWorld's sea plane makes.
  opacity: 0.78,
  roughness: 0.18,
  metalness: 0.12,
  side: THREE.DoubleSide,
  // Coplanar with nothing, but the shallows come very close to the bed and
  // z-fighting across a whole river is impossible to miss.
  polygonOffset: true,
  polygonOffsetFactor: -6,
  polygonOffsetUnits: -6,
});

function addArea(
  area: WaterArea,
  height: HeightField,
  positions: number[],
  colors: number[],
  indices: number[],
): void {
  const ring = area.points;
  if (ring.length < 3) {
    return;
  }

  let lowest = Infinity;
  for (const point of ring) {
    lowest = Math.min(lowest, height(point.x, point.z));
  }
  if (!Number.isFinite(lowest)) {
    return;
  }

  const surface = lowest + DEPTH_M;
  const [r, g, b] = area.color;
  const first = positions.length / 3;

  for (const point of ring) {
    positions.push(point.x, surface, point.z);
    colors.push(r, g, b);
  }

  // Double sided, so a ring of either winding is drawn from above. Cheaper
  // than working out the handedness of every lake in London.
  const contour = ring.map((point) => new THREE.Vector2(point.x, point.z));
  for (const [a, b2, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
    indices.push(first + a, first + c, first + b2);
  }
}

function buildWaterGeometry(
  areas: WaterArea[],
  height: HeightField,
): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (const area of areas) {
    if (area.line) {
      if (area.width > 0 && area.points.length >= 2) {
        addRibbon(
          { points: area.points, width: area.width, lift: LINE_LIFT_M, color: area.color },
          height,
          positions,
          colors,
          indices,
        );
      }
    } else {
      addArea(area, height, positions, colors, indices);
    }
  }

  if (indices.length === 0) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  // Water is flat and horizontal wherever it is, so this is exactly right here
  // rather than merely close, as it is for the roads.
  geometry.setAttribute("normal", new THREE.BufferAttribute(upwardNormals(positions), 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export function WaterLayer({
  water,
  height,
}: {
  water: WaterArea[];
  height: HeightField;
}): React.ReactElement | null {
  const geometry = useMemo(() => buildWaterGeometry(water, height), [water, height]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (geometry == null) {
    return null;
  }

  // Deliberately not shootable: paint floating on a river would sit on a
  // surface nothing else in the game treats as solid, and you can walk through
  // it. Nor does it collide — you wade.
  return <mesh geometry={geometry} material={WATER_MATERIAL} frustumCulled={false} />;
}
