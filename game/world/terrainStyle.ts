/**
 * Which world the terrain renderer is drawing.
 *
 * There are two — the procedural DechoWorld and the DEM-backed DechoWorld 2 —
 * and they differ only in the four things below, so they share every line of
 * the chunking, meshing, caching, digging and levelling rather than each having
 * a copy of it.
 *
 * Its own module rather than a corner of World.tsx: a file that exports both
 * components and constants loses fast refresh, and this is imported by Game as
 * well as by the renderer.
 */
import {
  CHUNK_SIZE,
  type HeightField,
  SEA_LEVEL,
  VIEW_RADIUS_CHUNKS,
  colorAt,
  heightAt,
} from "@/game/world/worldgen";

export interface TerrainStyle {
  /**
   * Cache namespace. Chunk geometry is cached by coordinate, and the two
   * worlds have a chunk 0:0 each — without this they would hand each other the
   * wrong hillside.
   */
  id: string;
  base: HeightField;
  color: (x: number, z: number, height: number) => [number, number, number];
  /** Chunks kept loaded in each direction around the player. */
  viewRadius: number;
  /** Where the water sits, in world y. */
  seaLevel: number;
}

export const PROCEDURAL_TERRAIN: TerrainStyle = {
  id: "procedural",
  base: heightAt,
  color: colorAt,
  viewRadius: VIEW_RADIUS_CHUNKS,
  seaLevel: SEA_LEVEL,
};

/** How far the eye reaches, in metres, for the fog to close at. */
export function viewDistance(terrain: TerrainStyle): number {
  return CHUNK_SIZE * terrain.viewRadius * 1.6;
}
