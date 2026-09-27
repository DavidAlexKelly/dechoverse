import React, { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Crater, FlatPad } from "@/game/domain/types";
import { PROCEDURAL_TERRAIN, type TerrainStyle, viewDistance } from "@/game/world/terrainStyle";
import {
  CHUNK_SEGMENTS,
  CHUNK_SIZE,
  cratersNear,
  padsNear,
  sampleHeight,
} from "@/game/world/worldgen";

/**
 * Geometry is expensive to build, so chunks are cached by coordinate and
 * reused when the player wanders back. The cap keeps memory bounded on a long
 * walk; the oldest entry is dropped, which is the one furthest behind.
 */
const geometryCache = new Map<string, THREE.BufferGeometry>();
/**
 * Bigger than the largest view, or the cache cannot do its job.
 *
 * DechoWorld 2 keeps 11 x 11 chunks loaded, and every one of them is live and
 * therefore ineligible for eviction — so a limit of 96 meant the sweep found
 * nothing to drop, ran over its limit on every insert, and grew without bound
 * as the player walked. This leaves room for the whole view plus the ring
 * behind it, which is exactly what a player turning round wants anyway.
 */
const GEOMETRY_CACHE_LIMIT = 320;

/**
 * Geometries currently attached to a mounted chunk. Eviction must never
 * dispose one of these.
 *
 * Digging added a cache entry per click, which the limit absorbed easily.
 * Flatten lays down a pad every metre or so of sweep, and every pad changes
 * the cache key of each chunk it touches, so the limit is reached in seconds.
 * At that point plain insertion-order eviction starts disposing the oldest
 * entries — which are the geometries of the chunks currently on screen. The
 * renderer then has to re-upload them, every frame, for as long as the sweep
 * continues.
 */
const liveGeometries = new Set<THREE.BufferGeometry>();

function chunkKey(cx: number, cz: number): string {
  return `${cx}:${cz}`;
}

/**
 * Cache identity for a chunk. Includes the craters that touch it, so digging
 * invalidates only the chunks that actually changed rather than the whole
 * visible world.
 */
function chunkCacheKey(
  terrain: TerrainStyle,
  cx: number,
  cz: number,
  craters: Crater[],
  pads: FlatPad[],
): string {
  const edits = [...craters.map((c) => c.id), ...pads.map((pad) => pad.id)].sort().join(",");
  return `${terrain.id}|${cx}:${cz}|${edits}`;
}

/**
 * Builds one chunk of terrain: a grid displaced by heightAt, coloured per
 * vertex, with flat shading for the low-poly facets.
 */
function buildChunkGeometry(
  terrain: TerrainStyle,
  cx: number,
  cz: number,
  craters: Crater[],
  pads: FlatPad[],
): THREE.BufferGeometry {
  const key = chunkCacheKey(terrain, cx, cz, craters, pads);
  const cached = geometryCache.get(key);
  if (cached != null) {
    return cached;
  }

  const geometry = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, CHUNK_SEGMENTS, CHUNK_SEGMENTS);
  // PlaneGeometry is upright by default; lay it flat.
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;

  for (let index = 0; index < position.count; index++) {
    const worldX = originX + position.getX(index);
    const worldZ = originZ + position.getZ(index);
    const height = sampleHeight(worldX, worldZ, craters, pads, terrain.base);
    position.setY(index, height);

    const [r, g, b] = terrain.color(worldX, worldZ, height);
    colors[index * 3] = r;
    colors[index * 3 + 1] = g;
    colors[index * 3 + 2] = b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  if (geometryCache.size >= GEOMETRY_CACHE_LIMIT) {
    // Oldest first, but skipping anything still on screen. If every entry is
    // live the cache simply runs over its limit for a moment, which is far
    // cheaper than disposing geometry that is about to be drawn.
    for (const [cachedKey, cached] of geometryCache) {
      if (liveGeometries.has(cached)) {
        continue;
      }
      cached.dispose();
      geometryCache.delete(cachedKey);
      break;
    }
  }
  geometryCache.set(key, geometry);
  return geometry;
}

function TerrainChunk({
  terrain,
  cx,
  cz,
  craters,
  pads,
}: {
  terrain: TerrainStyle;
  cx: number;
  cz: number;
  craters: Crater[];
  pads: FlatPad[];
}): React.ReactElement {
  // Only the edits overlapping this chunk matter, and only they should trigger
  // a rebuild.
  const localCraters = useMemo(
    () => cratersNear(craters, cx * CHUNK_SIZE, cz * CHUNK_SIZE, CHUNK_SIZE / 2),
    [craters, cx, cz],
  );
  const localPads = useMemo(
    () => padsNear(pads, cx * CHUNK_SIZE, cz * CHUNK_SIZE, CHUNK_SIZE / 2),
    [pads, cx, cz],
  );
  const geometry = useMemo(
    () => buildChunkGeometry(terrain, cx, cz, localCraters, localPads),
    [terrain, cx, cz, localCraters, localPads],
  );

  // Mark this geometry as on screen for as long as the chunk is mounted, so
  // cache eviction cannot dispose it out from under the renderer.
  useEffect(() => {
    liveGeometries.add(geometry);
    return () => {
      liveGeometries.delete(geometry);
    };
  }, [geometry]);

  return (
    <mesh
      geometry={geometry}
      position={[cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE]}
      userData={{ shootable: true }}
    >
      <meshStandardMaterial vertexColors flatShading roughness={0.95} metalness={0} />
    </mesh>
  );
}

/**
 * Endless terrain: chunks are generated around the player and recycled as they
 * walk. The set only changes when the player crosses a chunk boundary, so this
 * does not re-render per frame.
 */
export function DechoWorld({
  craters,
  pads,
  terrain = PROCEDURAL_TERRAIN,
}: {
  craters: Crater[];
  pads: FlatPad[];
  terrain?: TerrainStyle;
}): React.ReactElement {
  const { camera } = useThree();
  const [center, setCenter] = useState<{ cx: number; cz: number }>(() => ({
    cx: Math.round(camera.position.x / CHUNK_SIZE),
    cz: Math.round(camera.position.z / CHUNK_SIZE),
  }));
  const water = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const cx = Math.round(camera.position.x / CHUNK_SIZE);
    const cz = Math.round(camera.position.z / CHUNK_SIZE);
    if (cx !== center.cx || cz !== center.cz) {
      setCenter({ cx, cz });
    }

    // The sea is one big plane that follows the player rather than a grid.
    if (water.current != null) {
      water.current.position.x = camera.position.x;
      water.current.position.z = camera.position.z;
    }
  });

  const chunks = useMemo(() => {
    const list: Array<{ key: string; cx: number; cz: number }> = [];
    for (let dz = -terrain.viewRadius; dz <= terrain.viewRadius; dz++) {
      for (let dx = -terrain.viewRadius; dx <= terrain.viewRadius; dx++) {
        const cx = center.cx + dx;
        const cz = center.cz + dz;
        list.push({ key: chunkKey(cx, cz), cx, cz });
      }
    }
    return list;
  }, [center, terrain.viewRadius]);

  const waterSize = CHUNK_SIZE * (terrain.viewRadius * 2 + 3);

  return (
    <group>
      {chunks.map((chunk) => (
        <TerrainChunk
          key={chunk.key}
          terrain={terrain}
          cx={chunk.cx}
          cz={chunk.cz}
          craters={craters}
          pads={pads}
        />
      ))}

      {/* Sea level. Transparent so shallow ground reads as beach. */}
      <mesh ref={water} rotation={[-Math.PI / 2, 0, 0]} position={[0, terrain.seaLevel, 0]}>
        <planeGeometry args={[waterSize, waterSize]} />
        <meshStandardMaterial
          color="#2f7fb5"
          transparent
          opacity={0.72}
          roughness={0.25}
          metalness={0.1}
        />
      </mesh>
    </group>
  );
}

/**
 * Daylight for DechoWorld: warm sun, sky bounce, and a bright horizon.
 *
 * Returns a fragment rather than a group on purpose. `attach="background"` and
 * `attach="fog"` bind to the parent object in the scene graph, so wrapping
 * these in a group would attach them to that group instead of the scene — and
 * the sky would stay black.
 */
export function DaylightSky({
  terrain = PROCEDURAL_TERRAIN,
}: {
  terrain?: TerrainStyle;
}): React.ReactElement {
  return (
    <>
      <color attach="background" args={["#9ad0f5"]} />
      <fog attach="fog" args={["#b9dcf7", 60, viewDistance(terrain)]} />
      {/*
       * Weighted hard towards directional light on purpose. Ambient is
       * direction independent and hemisphere only varies up against down, so
       * leaning on either gives every vertical face the same value and the
       * geometry reads flat — most visible on untextured cubes, where all
       * four sides would otherwise be identical.
       */}
      <ambientLight intensity={0.8} />
      <hemisphereLight args={["#bfe3ff", "#4e6a3a", 0.55]} />
      <directionalLight position={[60, 90, 40]} intensity={2.2} color="#fff6e0" />
      {/* Cool fill from a different azimuth, so the faces the sun misses are
          still separated from each other rather than all falling to ambient. */}
      <directionalLight position={[-50, 25, -35]} intensity={0.5} color="#9fc4e8" />
    </>
  );
}
