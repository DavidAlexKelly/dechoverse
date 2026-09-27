import { describe, expect, test, vi } from "vitest";
import type { MarkRecord } from "@/foundry/streams/marks";
import { foldCubes, foldObjects, foldPads, mergeMarks } from "@/game/state/markFold";

// The furniture catalogue measures model footprints through the Platform SDK;
// the fold only needs its kind check, so the SDK side is stubbed out. (vi.mock
// is hoisted above the imports.)
vi.mock("@/foundry/models", () => ({
  footprintOf: () => ({ halfX: 0.5, halfZ: 0.5, height: 1 }),
}));

function mark(overrides: Partial<MarkRecord>): MarkRecord {
  return {
    timestamp: 1,
    markId: "m",
    levelKey: "world:plains",
    deleted: false,
    userId: "Dana",
    schemaVersion: 2,
    ...overrides,
  };
}

describe("mergeMarks", () => {
  test("newest timestamp per markId wins, and an unchanged fold is the same map", () => {
    const first = mergeMarks(new Map(), [mark({ markId: "a", timestamp: 5, kind: "cube" })]);
    expect(first.get("a")?.timestamp).toBe(5);
    expect(mergeMarks(first, [mark({ markId: "a", timestamp: 3 })])).toBe(first);
    const erased = mergeMarks(first, [mark({ markId: "a", timestamp: 6, deleted: true })]);
    expect(erased.get("a")?.deleted).toBe(true);
    expect(first.get("a")?.deleted).toBe(false);
  });
});

describe("folds", () => {
  const marks = mergeMarks(new Map(), [
    mark({ markId: "c1", kind: "cube", x: 1.5, y: 0.5, z: 2.5, color: "#ff0000", width: 0.5 }),
    mark({ markId: "c2", kind: "cube", x: 1.5, y: 1.5, z: 2.5 }),
    mark({ markId: "c3", kind: "cube", levelKey: "world:earth", x: 0, y: 0, z: 0 }),
    mark({ markId: "gone", kind: "cube", deleted: true }),
    mark({ markId: "chair", kind: "chair", x: 4, z: 4, qy: 0, qw: 1 }),
    mark({ markId: "sweep", kind: "sweep", y: 2, size: 3, points: "1,2,3,4" }),
  ]);

  test("cubes in this room only, with opacity from width", () => {
    const cubes = foldCubes(marks, "world:plains");
    expect(cubes.map((cube) => cube.id).sort()).toEqual(["c1", "c2"]);
    expect(cubes.find((cube) => cube.id === "c1")?.opacity).toBe(0.5);
    expect(cubes.find((cube) => cube.id === "c2")?.opacity).toBe(1);
  });

  test("props and swept pads", () => {
    expect(foldObjects(marks, "world:plains").map((object) => object.id)).toEqual(["chair"]);
    expect(foldPads(marks, "world:plains")).toHaveLength(2);
  });
});
