import { describe, expect, test } from "vitest";
import { mentionsName } from "@/agents/config/identity";

describe("mentionsName", () => {
  test("the whole name, or a distinctive part of it", () => {
    expect(mentionsName("French Claude, what do you think?", "French Claude")).toBe(true);
    expect(mentionsName("Claude, what do you think?", "French Claude")).toBe(true);
    expect(mentionsName("hey gemini!", "Sad Gemini")).toBe(true);
  });

  test("short words of a name are not enough on their own", () => {
    expect(mentionsName("that is so sad", "Sad Gemini")).toBe(false);
    expect(mentionsName("a big wall", "Big Dave")).toBe(false);
  });

  test("whole words only", () => {
    expect(mentionsName("claudette is here", "French Claude")).toBe(false);
    expect(mentionsName("Dave's tower", "Dave")).toBe(true);
  });
});
