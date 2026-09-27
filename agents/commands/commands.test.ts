import { describe, expect, test } from "vitest";
import { type AgentControl, type CommandContext, runCommand, tokenize } from "@/agents/commands/commands";
import type { Persona } from "@/agents/config/personas";
import type { SpawnOptions } from "@/agents/host/AgentHost";
import type { LevelGeometry } from "@/agents/world/levels";

const PLAINS: LevelGeometry = {
  levelKey: "world:plains",
  base: () => 0,
  halfSize: null,
  seaLevel: 0,
  label: "DechoWorld",
  buildable: true,
};

function fakeHost(): AgentControl & { spawned: Array<{ persona: Persona; options: SpawnOptions }> } {
  const spawned: Array<{ persona: Persona; options: SpawnOptions }> = [];
  return {
    spawned,
    spawn: (persona, options) => {
      spawned.push({ persona, options });
    },
    despawn: (id) => {
      const index = spawned.findIndex((entry) => entry.persona.id === id);
      if (index >= 0) {spawned.splice(index, 1);}
    },
    findByName: (name) =>
      spawned.find((entry) => entry.persona.name.toLowerCase() === name.toLowerCase())?.persona.id ??
      null,
    has: (id) => spawned.some((entry) => entry.persona.id === id),
    configureJev: () => undefined,
    snapshot: () => ({
      agents: spawned.map((entry) => ({
        id: entry.persona.id,
        name: entry.persona.name,
        userId: `${entry.persona.name} 🤖`,
        levelKey: entry.options.levelKey,
        model: entry.options.model,
        mode: "IDLE" as const,
        goal: null,
        partner: null,
        plan: null,
        position: [0, 0, 0] as [number, number, number],
        lastSaid: null,
        reflexes: null,
        jev: { calls: 0, failures: 0, lastLatencyMs: 0, error: null },
        brain: { calls: 0, failures: 0, busy: null, error: null },
      })),
      log: [],
      jevConfigured: false,
      jevModel: null,
      jevError: null,
      spentDollars: 0,
      presenceError: null,
      marksError: null,
      links: {},
    }),
  };
}

function context(host: AgentControl, geometry: LevelGeometry | null = PLAINS): CommandContext {
  return {
    host,
    room: { levelKey: "world:plains", label: "DechoWorld", geometry },
    pose: { x: 10, z: 20, yaw: 0 },
  };
}

describe("tokenize", () => {
  test("keeps quoted names together", () => {
    expect(tokenize('createagent claude "Big Dave" loves bridges')).toEqual([
      "createagent",
      "claude",
      "Big Dave",
      "loves",
      "bridges",
    ]);
  });
});

describe("createagent", () => {
  test("spawns in the current room, in front of the player", () => {
    const host = fakeHost();
    const result = runCommand("createagent gemini Dave a grumpy old builder", context(host));
    expect(result.ok).toBe(true);
    const [{ persona, options }] = host.spawned;
    expect(options).toMatchObject({ model: "gemini-3-6-flash", levelKey: "world:plains", geometry: PLAINS });
    expect(persona.name).toBe("Dave");
    expect(persona.persona).toContain("a grumpy old builder");
    // yaw 0 faces -Z: three metres ahead of (10, 20).
    expect(persona.home[0]).toBeCloseTo(10);
    expect(persona.home[1]).toBeCloseTo(17);
  });

  test("model aliases", () => {
    const host = fakeHost();
    runCommand("createagent claude A", context(host));
    runCommand("createagent GPT B", context(host));
    expect(host.spawned.map((entry) => entry.options.model)).toEqual(["claude-haiku-4-5", "gpt-5-4-mini"]);
  });

  test("a default personality when none is given", () => {
    const host = fakeHost();
    runCommand("createagent gpt Mo", context(host));
    expect(host.spawned[0].persona.persona).toContain("Friendly");
  });

  test("refuses unknown models, bad names, duplicates and unloaded rooms", () => {
    const host = fakeHost();
    expect(runCommand("createagent llama Dave", context(host)).ok).toBe(false);
    expect(runCommand("createagent gpt", context(host)).ok).toBe(false);
    expect(runCommand('createagent gpt "<script>"', context(host)).ok).toBe(false);
    expect(runCommand("createagent gpt Dave", context(host, null)).ok).toBe(false);
    expect(runCommand("createagent gpt Dave", context(host)).ok).toBe(true);
    expect(runCommand("createagent claude dave", context(host)).ok).toBe(false);
    expect(host.spawned).toHaveLength(1);
  });
});

describe("other commands", () => {
  test("agents lists, removeagent removes", () => {
    const host = fakeHost();
    runCommand("createagent gemini Dave", context(host));
    const listed = runCommand("agents", context(host)).lines;
    expect(listed[0]).toContain("Jev: off");
    expect(listed[1]).toContain("Dave 🤖");
    expect(runCommand("removeagent dave", context(host)).ok).toBe(true);
    expect(host.spawned).toHaveLength(0);
    expect(runCommand("removeagent dave", context(host)).ok).toBe(false);
  });

  test("unknown commands say so, and a leading backslash is ignored", () => {
    const host = fakeHost();
    expect(runCommand("dance", context(host)).ok).toBe(false);
    expect(runCommand("\\help", context(host)).ok).toBe(true);
  });
});
