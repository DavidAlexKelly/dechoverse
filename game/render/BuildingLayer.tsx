import React, { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { Building } from "@/game/world/surface";
import type { HeightField } from "@/game/world/worldgen";

/**
 * The city, standing up.
 *
 * These used to be instanced boxes, because that is all the data could
 * support: the client saw no footprints and invented a building per landuse
 * cell, so every one of them was the same box scaled differently. The bake
 * carries real outlines now, and a box cannot be one — a merged terrace is an
 * L, a wharf is a wedge, and a roundabout has buildings curved around it.
 *
 * So each footprint is extruded: a quad per edge for the walls, and a
 * triangulated cap for the roof.
 *
 * WHY THEY ARE MERGED INTO A HANDFUL OF MESHES
 * --------------------------------------------
 * Instancing is out — every building is now a different shape — and a mesh
 * each would be thousands of draw calls. So buildings are grouped into blocks
 * of MERGE_CELL_M and each block becomes one mesh with vertex colours.
 *
 * Deliberately not ONE mesh for the whole city: a single geometry is either
 * entirely drawn or entirely culled, so the half of the city behind the player
 * would be submitted every frame. Blocks are the compromise — few enough that
 * the draw calls do not matter, small enough that the frustum can reject most
 * of them.
 *
 * WHY THEY SINK INTO THE GROUND
 * -----------------------------
 * A footprint is flat and the ground under it is not. Sitting a building on
 * the height at its centre leaves a gap under the downhill corner on any slope
 * at all — and London has enough slope to show it. The base is taken from the
 * LOWEST ground under the outline and then pushed a little further in, which
 * costs nothing since nobody can see the bottom of a buried wall.
 */
const FOUNDATION_M = 2.5;

/** Side of one merge block, in metres. See above. */
const MERGE_CELL_M = 128;

/**
 * One material for the whole city.
 *
 * Module level for the reason CubeLayer's is: a material created in a
 * component is created again on every render and the old one is never given
 * back to the GPU.
 */
const BUILDING_MATERIAL = new THREE.MeshStandardMaterial({
  // White, so the per-vertex colour comes through unmodified.
  color: "#ffffff",
  roughness: 0.85,
  metalness: 0,
  // The walls are already separate faces with their own normals; what this
  // buys is that they stay separate rather than being smoothed into a lump.
  flatShading: true,
  // A merged block is a collection of closed boxes, so nothing should be
  // visible from behind. Backface culling halves what the rasteriser does.
  side: THREE.FrontSide,
});

/**
 * Appends one building's walls and roof to the buffers of its block.
 *
 * The outline arrives in whatever winding the source had — a merged Protomaps
 * polygon can be either — so the walls are emitted as two triangles per edge
 * with both orderings folded into one quad, and the roof is triangulated by
 * three.js against the ring's own winding. Getting this wrong shows as a
 * building you can see through from one side, which is why the roof cap is
 * checked against the signed area rather than assumed.
 */
function addBuilding(
  building: Building,
  height: HeightField,
  positions: number[],
  colors: number[],
  indices: number[],
): void {
  const ring = building.footprint;
  if (ring.length < 3) {
    return;
  }

  // The lowest ground under the outline, so no corner can lift off the hill.
  let lowest = Infinity;
  for (const point of ring) {
    lowest = Math.min(lowest, height(point.x, point.z));
  }
  if (!Number.isFinite(lowest)) {
    return;
  }

  const base = lowest - FOUNDATION_M;
  // Measured from the ground at the centre rather than from the base, so a
  // declared height is the height of the building and not of the foundation
  // plus the building.
  const roof = height(building.x, building.z) + building.height;
  if (roof <= base) {
    return;
  }

  const [r, g, b] = building.color;
  const push = (x: number, y: number, z: number): number => {
    const index = positions.length / 3;
    positions.push(x, y, z);
    colors.push(r, g, b);
    return index;
  };

  // ── Walls: a quad per edge, wound so its outward face is the visible one ──
  //
  // Signed area tells us which way the ring goes, and the quad's winding is
  // flipped to match. A ring's handedness is a property of whoever exported
  // it, and both appear in these tiles.
  let signedArea = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    signedArea += (ring[j].x - ring[i].x) * (ring[j].z + ring[i].z);
  }
  const clockwise = signedArea > 0;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const from = ring[j];
    const to = ring[i];

    const bottomFrom = push(from.x, base, from.z);
    const bottomTo = push(to.x, base, to.z);
    const topFrom = push(from.x, roof, from.z);
    const topTo = push(to.x, roof, to.z);

    if (clockwise) {
      indices.push(bottomFrom, bottomTo, topTo, bottomFrom, topTo, topFrom);
    } else {
      indices.push(bottomFrom, topTo, bottomTo, bottomFrom, topFrom, topTo);
    }
  }

  // ── Roof: the ring, triangulated flat ─────────────────────────────────────
  //
  // ShapeUtils wants the contour in 2D and returns triples of indices into it.
  // A self-intersecting ring — which a simplified merged polygon can be —
  // makes it return nothing rather than throw, and a building with walls and
  // no lid is a great deal better than an exception on entering the world.
  const contour = ring.map((point) => new THREE.Vector2(point.x, point.z));
  const roofFirst = positions.length / 3;
  for (const point of ring) {
    push(point.x, roof, point.z);
  }

  for (const [first, second, third] of THREE.ShapeUtils.triangulateShape(contour, [])) {
    // Reversed relative to what the triangulator returns, so the roof faces
    // the sky: it works in a right-handed 2D plane, and mapping y to z makes
    // every triangle come out wound the other way.
    indices.push(roofFirst + first, roofFirst + third, roofFirst + second);
  }
}

function blockKey(building: Building): string {
  return `${Math.floor(building.x / MERGE_CELL_M)}:${Math.floor(building.z / MERGE_CELL_M)}`;
}

function buildBlockGeometry(
  buildings: Building[],
  height: HeightField,
): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (const building of buildings) {
    addBuilding(building, height, positions, colors, indices);
  }

  if (indices.length === 0) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  // Per face rather than per vertex, which is what makes each wall a flat
  // plane with its own shade instead of a smooth bulge.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function BuildingLayer({
  buildings,
  height,
}: {
  buildings: Building[];
  height: HeightField;
}): React.ReactElement | null {
  // Grouped and built together: the height field is the expensive part — a
  // sample per outline vertex — so it is paid once per city rather than per
  // frame, and the result is geometry the GPU already has.
  const blocks = useMemo(() => {
    const grouped = new Map<string, Building[]>();
    for (const building of buildings) {
      const key = blockKey(building);
      const block = grouped.get(key);
      if (block == null) {
        grouped.set(key, [building]);
      } else {
        block.push(building);
      }
    }

    const built: Array<{ key: string; geometry: THREE.BufferGeometry }> = [];
    for (const [key, block] of grouped) {
      const geometry = buildBlockGeometry(block, height);
      if (geometry != null) {
        built.push({ key, geometry });
      }
    }
    return built;
  }, [buildings, height]);

  // Handed back to the GPU when the city changes, which is once per visit.
  useEffect(
    () => () => {
      for (const block of blocks) {
        block.geometry.dispose();
      }
    },
    [blocks],
  );

  if (blocks.length === 0) {
    return null;
  }

  return (
    <group>
      {blocks.map((block) => (
        <mesh
          key={block.key}
          geometry={block.geometry}
          material={BUILDING_MATERIAL}
          // Paint sticks to walls, and the eraser takes it off again. The
          // instanced boxes this replaced were not shootable, so bullets went
          // straight through a building you could not walk into.
          userData={{ shootable: true }}
        />
      ))}
    </group>
  );
}
