import {
  MYSPACE_HALF_SIZE,
  WORLD_LEVEL_KEY,
  myspaceLevelKey,
  myspaceOwner,
} from "@/game/world/level";
import { type HeightField, SEA_LEVEL, heightAt } from "@/game/world/worldgen";

/**
 * The rooms an AI player can live in, and what their ground is.
 *
 * Deliberately short. DechoWorld is procedural and pure, so an agent knows its
 * ground without reading a byte; a personal room is a flat floor with walls.
 * DechoWorld 2 is left out because its ground is a DEM streamed from a
 * dataset, and the Spaces rooms because they are furnished by the filesystem
 * rather than by marks — neither is somewhere an agent could see properly.
 */
export interface LevelGeometry {
  levelKey: string;
  /** Ground height before any digging or levelling. */
  base: HeightField;
  /** Half-width of a walled room, or null for open world. */
  halfSize: number | null;
  /** Water to keep out of, or null where there is none. */
  seaLevel: number | null;
  /** Human readable, for the console. */
  label: string;
}

const FLAT: HeightField = () => 0;

export function levelGeometry(levelKey: string): LevelGeometry | null {
  if (levelKey === WORLD_LEVEL_KEY) {
    return {
      levelKey,
      base: heightAt,
      halfSize: null,
      seaLevel: SEA_LEVEL,
      label: "DechoWorld",
    };
  }
  const owner = myspaceOwner(levelKey);
  if (owner != null) {
    return {
      levelKey,
      base: FLAT,
      halfSize: MYSPACE_HALF_SIZE,
      seaLevel: null,
      label: `${owner}'s Space`,
    };
  }
  return null;
}

/**
 * Where an agent may be sent and may write: DechoWorld, and its own room.
 *
 * Never somebody else's personal room — the game makes those read only for
 * visitors, and an agent is held to the same rule.
 */
export function allowedLevels(agentUserId: string): string[] {
  return [WORLD_LEVEL_KEY, myspaceLevelKey(agentUserId)];
}
