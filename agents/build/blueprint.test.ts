import { describe, expect, test } from "vitest";
import { parseReview } from "@/agents/brain/parse";
import { buildable, cellKey, drawSite, expandParts } from "@/agents/build/blueprint";

const PALETTE = ["#aa7744", "#cc3333"];

function cells(parts: unknown[]): string[] {
  return [...expandParts(parts, PALETTE).cubes.keys()].sort();
}

describe("expandParts", () => {
  test("a wall is a line of columns", () => {
    expect(cells([{ shape: "wall", from: [0, 0], to: [2, 0], height: 2 }])).toEqual(
      ["0,0,0", "0,1,0", "1,0,0", "1,1,0", "2,0,0", "2,1,0"].sort(),
    );
  });

  test("floor, pillar and cube", () => {
    expect(cells([{ shape: "floor", from: [0, 0], to: [1, 1], y: 0 }])).toHaveLength(4);
    expect(cells([{ shape: "pillar", at: [3, 3], height: 4, y: 1 }])).toEqual(
      ["3,1,3", "3,2,3", "3,3,3", "3,4,3"],
    );
    expect(cells([{ shape: "cube", at: [1, 2, 3] }])).toEqual(["1,2,3"]);
  });

  test("a hollow box is only its shell", () => {
    expect(cells([{ shape: "box", from: [0, 0, 0], to: [2, 2, 2], hollow: true }])).toHaveLength(26);
    expect(cells([{ shape: "box", from: [0, 0, 0], to: [2, 2, 2] }])).toHaveLength(27);
  });

  test("roofs: flat, pyramid, and a gable along the longer side", () => {
    expect(cells([{ shape: "roof", from: [0, 0], to: [4, 4], y: 0, style: "flat" }])).toHaveLength(25);
    expect(cells([{ shape: "roof", from: [0, 0], to: [4, 4], y: 0, style: "pyramid" }])).toHaveLength(
      25 + 9 + 1,
    );
    // 5 long in x, 3 deep in z: layers of 5×3 then 5×1.
    expect(cells([{ shape: "roof", from: [0, 0], to: [4, 2], y: 0, style: "pitched" }])).toHaveLength(
      15 + 5,
    );
  });

  test("an arch has two legs and a span over the gap", () => {
    const arch = cells([{ shape: "arch", from: [0, 0], to: [3, 0], height: 2 }]);
    expect(arch).toContain("0,0,0");
    expect(arch).toContain("3,1,0");
    expect(arch).toContain("1,2,0");
    expect(arch).not.toContain("1,0,0");
  });

  test("clear cuts openings out of what came before", () => {
    const expansion = expandParts(
      [
        { shape: "wall", from: [0, 0], to: [2, 0], height: 3 },
        { shape: "clear", from: [1, 0, 0], to: [1, 1, 0] },
      ],
      PALETTE,
    );
    expect(expansion.cubes.has("1,0,0")).toBe(false);
    expect(expansion.cubes.has("1,2,0")).toBe(true);
    expect(expansion.cleared.has("1,1,0")).toBe(true);
  });

  test("palette indices choose colours, and bad parts are skipped", () => {
    const expansion = expandParts(
      [{ shape: "cube", at: [0, 0, 0], c: 1 }, { shape: "blob" }, { shape: "wall", from: "x" }],
      PALETTE,
    );
    expect([...expansion.cubes.values()]).toEqual([{ dx: 0, dy: 0, dz: 0, color: "#cc3333" }]);
  });
});

describe("buildable", () => {
  const cube = (dx: number, dy: number, dz: number) => ({ dx, dy, dz, color: "#000000" });

  test("keeps what connects to the ground through any face, drops the rest", () => {
    const { cubes, dropped } = buildable(
      [cube(0, 0, 0), cube(0, 1, 0), cube(1, 1, 0), cube(5, 5, 5)],
      7,
      100,
    );
    expect(cubes.map(cellKey)).toEqual(["0,0,0", "0,1,0", "1,1,0"]);
    expect(dropped).toBe(1);
  });

  test("an arch goes up legs first, and its span from the legs inwards", () => {
    const parts = expandParts([{ shape: "arch", from: [0, 0], to: [4, 0], height: 2 }], ["#000000"]);
    const { cubes } = buildable(parts.cubes.values(), 7, 100);
    const order = cubes.map(cellKey);
    const placed = new Set<string>();
    for (const key of order) {
      const [x, y, z] = key.split(",").map(Number);
      const touches =
        y === 0 ||
        [
          [0, -1, 0],
          [1, 0, 0],
          [-1, 0, 0],
          [0, 0, 1],
          [0, 0, -1],
        ].some(([a, b, c]) => placed.has(`${x + a},${y + b},${z + c}`));
      expect(touches).toBe(true);
      placed.add(key);
    }
    expect(order).toHaveLength(2 * 2 + 5);
  });

  test("outside the site, too high, and over the limit are dropped", () => {
    const { cubes } = buildable(
      [cube(7, 0, 0), cube(-1, 0, 0), cube(0, 0, 0), cube(1, 0, 0), cube(2, 0, 0)],
      7,
      2,
    );
    expect(cubes).toHaveLength(2);
  });

  test("cubes may rest on what already stands", () => {
    const { cubes } = buildable([cube(0, 3, 0)], 7, 10, new Set(["0,2,0"]));
    expect(cubes).toHaveLength(1);
  });
});

describe("drawSite", () => {
  test("one grid per layer, top first, with palette letters", () => {
    const picture = drawSite(
      new Map([
        ["0,0,0", "#aa7744"],
        ["1,0,0", "#123456"],
        ["0,1,0", "#cc3333"],
      ]),
      3,
      PALETTE,
    );
    expect(picture.indexOf("layer y=1")).toBeLessThan(picture.indexOf("layer y=0"));
    expect(picture).toContain(" 0 a#.");
    expect(picture).toContain(" 0 b..");
  });

  test("an empty site says so", () => {
    expect(drawSite(new Map(), 5, PALETTE)).toBe("(nothing built yet)");
  });
});

describe("parseReview", () => {
  const standing = new Set(["0,0,0", "0,1,0"]);

  test("adds parts that rest on what stands or is queued, and removes by clear", () => {
    const review = parseReview(
      JSON.stringify({
        status: "continue",
        palette: ["#333333"],
        parts: [
          { shape: "pillar", at: [0, 0], y: 2, height: 2, c: 2 },
          { shape: "cube", at: [3, 3, 3], c: 0 },
          { shape: "clear", from: [0, 1, 0], to: [0, 1, 0] },
          { shape: "clear", from: [4, 0, 4], to: [4, 0, 4] },
        ],
      }),
      7,
      PALETTE,
      standing,
      50,
      new Set(["4,0,4"]),
    );
    expect(review?.palette).toEqual([...PALETTE, "#333333"]);
    // The pillar's base rested on 0,1,0, which is being cleared: nothing holds it up.
    expect(review?.add).toHaveLength(0);
    expect(review?.remove.sort()).toEqual(["0,1,0", "4,0,4"]);
  });

  test("done ends it, and an unreadable reply is no review", () => {
    expect(parseReview('{"status":"done"}', 7, PALETTE, standing, 10)?.done).toBe(true);
    expect(parseReview("", 7, PALETTE, standing, 10)).toBeNull();
  });
});
