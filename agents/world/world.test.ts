import { describe, expect, test } from "vitest";
import { findPath } from "@/agents/body/pathing";
import { Body } from "@/agents/body/Body";
import type { LevelGeometry } from "@/agents/world/levels";
import { cubeCentre, findBuildSites } from "@/agents/world/sites";
import type { Cube } from "@/game/domain/types";
import type { VoxelWorld } from "@/game/world/collision";
import { buildVoxelMap } from "@/game/world/voxels";

/** A flat walled room, like a personal Space. */
const ROOM: LevelGeometry = {
  levelKey: "myspace:Test",
  base: () => 0,
  halfSize: 12,
  seaLevel: null,
  label: "Test room",
};

function cube(x: number, y: number, z: number): Cube {
  return { id: `${x},${y},${z}`, x: x + 0.5, y: y + 0.5, z: z + 0.5, color: "#000000", opacity: 1 };
}

function worldWith(cubes: Cube[]): VoxelWorld {
  return { voxels: buildVoxelMap(cubes), terrainAt: () => 0, props: [] };
}

/** A wall across x = 0 from z = -6 to z = 6, two cubes high. */
const WALL: Cube[] = [];
for (let z = -6; z <= 6; z++) {
  WALL.push(cube(0, 0, z), cube(0, 1, z));
}

describe("findPath", () => {
  test("open ground is a straight line", () => {
    const path = findPath(worldWith([]), ROOM, { x: -5, z: 0 }, { x: 5, z: 0 });
    expect(path).toHaveLength(1);
  });

  test("goes around a wall rather than through it", () => {
    const world = worldWith(WALL);
    const path = findPath(world, ROOM, { x: -4, z: 0.5 }, { x: 4, z: 0.5 });
    expect(path).not.toBeNull();
    expect(path?.length).toBeGreaterThan(1);
    // Some waypoint has to clear the end of the wall.
    expect(path?.some((point) => Math.abs(point.z) > 6)).toBe(true);
  });

  test("walking the path with real collision gets there", () => {
    const world = worldWith(WALL);
    const body = new Body({ x: -4, z: 0.5 }, ROOM, world);
    expect(body.goTo(world, { x: 4, z: 0.5 })).toBe(true);
    for (let tick = 0; tick < 400 && body.moving; tick++) {
      body.step(0.05, world);
    }
    expect(body.distanceTo({ x: 4.5, z: 0.5 })).toBeLessThan(1.2);
  });

  test("never out through a room's walls", () => {
    const world = worldWith([]);
    const body = new Body({ x: 0, z: 0 }, ROOM, world);
    body.goTo(world, { x: 40, z: 0 });
    for (let tick = 0; tick < 400; tick++) {
      body.step(0.05, world);
    }
    expect(Math.abs(body.x)).toBeLessThan(12);
  });
});

describe("findBuildSites", () => {
  test("offers empty flat ground and never overlaps what is built", () => {
    const world = worldWith(WALL);
    const sites = findBuildSites(world, ROOM, { x: 0, z: 0 }, 3, () => "open ground");
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      const crossesWall = site.cellX <= 0 && site.cellX + site.size > 0 && site.cellZ <= 6 && site.cellZ + site.size > -6;
      expect(crossesWall).toBe(false);
      expect(Math.abs(site.cellX)).toBeLessThan(12);
      expect(Math.abs(site.cellX + site.size)).toBeLessThanOrEqual(11);
    }
    expect(new Set(sites.map((site) => site.key)).size).toBe(sites.length);
  });

  test("cubes rest on the ground the way the build tool puts them", () => {
    const world = worldWith([]);
    const site = { key: "a", cellX: 2, cellZ: 3, size: 7, distance: 5, description: "" };
    expect(cubeCentre(world, site, { dx: 1, dy: 0, dz: 1 })).toEqual({ x: 3.5, y: 0.5, z: 4.5 });
    expect(cubeCentre(world, site, { dx: 1, dy: 2, dz: 1 }).y).toBe(2.5);
  });
});
