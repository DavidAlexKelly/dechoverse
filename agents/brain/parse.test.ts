import { describe, expect, test } from "vitest";
import {
  MAX_SAY_LENGTH,
  cleanSpeech,
  extractJsonObject,
  parseDecide,
  parsePlan,
  parseReply,
} from "@/agents/brain/parse";
import type { BuildSite } from "@/agents/brain/prompts";

const SITES: BuildSite[] = [
  { key: "a", cellX: 10, cellZ: -4, size: 7, distance: 8, description: "level with you" },
  { key: "b", cellX: -20, cellZ: 3, size: 7, distance: 20, description: "open ground" },
];

describe("extractJsonObject", () => {
  test("reads JSON wrapped in fences and prose", () => {
    expect(extractJsonObject('Sure!\n```json\n{"say":"hi"}\n```')).toEqual({ say: "hi" });
  });

  test("an empty reply is unanswered, not an object", () => {
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("[1,2]")).toBeNull();
  });
});

describe("parseReply", () => {
  test("accepts a reply to an offered message", () => {
    expect(parseReply('{"say":"Hello Dana!","replyTo":"m2","remember":null}', ["m1", "m2"])).toEqual(
      { say: "Hello Dana!", replyTo: "m2", remember: null, action: "none", build: null },
    );
  });

  test("carries an offered action, and what to build", () => {
    const reply = parseReply(
      '{"say":"On it!","replyTo":"m1","action":"build","build":"a stone bridge"}',
      ["m1"],
      ["none", "build", "follow"],
    );
    expect(reply?.action).toBe("build");
    expect(reply?.build).toBe("a stone bridge");
  });

  test("an action that was not offered is ignored, but the words still stand", () => {
    const reply = parseReply('{"say":"Sure","replyTo":"m1","action":"build"}', ["m1"], ["none", "follow"]);
    expect(reply?.say).toBe("Sure");
    expect(reply?.action).toBe("none");
  });

  test("rejects a reply to a message that was never offered", () => {
    expect(parseReply('{"say":"Hi","replyTo":"m9"}', ["m1"])).toBeNull();
  });

  test('an unprompted greeting answers "none"', () => {
    expect(parseReply('{"say":"Hi there","replyTo":"none"}', [])?.replyTo).toBe("none");
  });

  test("keeps something worth remembering", () => {
    expect(
      parseReply('{"say":"Nice!","replyTo":"m1","remember":"Dana loves towers"}', ["m1"])?.remember,
    ).toBe("Dana loves towers");
  });

  test("strips markdown and clamps length", () => {
    const long = `**${"word ".repeat(80)}**`;
    const reply = parseReply(JSON.stringify({ say: long, replyTo: "m1" }), ["m1"]);
    expect(reply?.say.includes("*")).toBe(false);
    expect(reply?.say.length).toBeLessThanOrEqual(MAX_SAY_LENGTH);
  });

  test("nothing to say is no reply", () => {
    expect(parseReply('{"say":"  ","replyTo":"m1"}', ["m1"])).toBeNull();
    expect(parseReply("", ["m1"])).toBeNull();
  });
});

describe("cleanSpeech", () => {
  test("cuts at a sentence end when there is one", () => {
    const text = `${"a".repeat(150)}. ${"b".repeat(100)}`;
    expect(cleanSpeech(text).endsWith(".")).toBe(true);
  });
});

describe("parseDecide", () => {
  test("accepts an offered key", () => {
    expect(parseDecide('{"choice":"help","why":"She asked."}', ["help", "explore"])).toEqual({
      choice: "help",
      why: "She asked.",
    });
  });

  test("rejects anything else", () => {
    expect(parseDecide('{"choice":"fly"}', ["help"])).toBeNull();
  });
});

describe("parsePlan", () => {
  const plan = (body: unknown): string => JSON.stringify(body);

  test("a valid plan on an offered site, ordered bottom-up", () => {
    const result = parsePlan(
      plan({
        title: "Tiny tower",
        site: "a",
        palette: ["#aa3300", "#ffffff"],
        cubes: [
          [0, 1, 0, 1],
          [0, 0, 0, 0],
          [1, 0, 0, 0],
        ],
      }),
      SITES,
      200,
    );
    expect(result?.site.key).toBe("a");
    expect(result?.cubes.map((cube) => cube.dy)).toEqual([0, 0, 1]);
    expect(result?.cubes[2].color).toBe("#ffffff");
    expect(result?.discarded).toBe(0);
  });

  test("an unoffered site is no plan at all", () => {
    expect(parsePlan(plan({ site: "z", palette: ["#000000"], cubes: [[0, 0, 0, 0]] }), SITES, 200)).toBeNull();
  });

  test("floating cubes, and everything they would have held up, are dropped", () => {
    const result = parsePlan(
      plan({
        site: "a",
        palette: ["#000000"],
        cubes: [
          [0, 0, 0, 0],
          [2, 1, 2, 0],
          [2, 2, 2, 0],
        ],
      }),
      SITES,
      200,
    );
    expect(result?.cubes).toHaveLength(1);
    expect(result?.discarded).toBe(2);
  });

  test("outside the site, bad colours and duplicates are dropped", () => {
    const result = parsePlan(
      plan({
        site: "a",
        palette: ["#000000", "red"],
        cubes: [
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [7, 0, 0, 0],
          [-1, 0, 0, 0],
          [1, 0, 1, 1],
          [1, 0, 1, 5],
        ],
      }),
      SITES,
      200,
    );
    expect(result?.cubes).toHaveLength(1);
  });

  test("never more than the cube limit", () => {
    const cubes = [];
    for (let dx = 0; dx < 7; dx++) {
      for (let dz = 0; dz < 7; dz++) {
        cubes.push([dx, 0, dz, 0]);
      }
    }
    const result = parsePlan(plan({ site: "a", palette: ["#000000"], cubes }), SITES, 10);
    expect(result?.cubes).toHaveLength(10);
  });
});
