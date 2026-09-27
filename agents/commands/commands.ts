import { agentUserId } from "@/agents/config/identity";
import type { Persona } from "@/agents/config/personas";
import { storeJev, storedJevModel } from "@/agents/config/session";
import type { AgentModelName } from "@/agents/data/brainClient";
import type { AgentHost } from "@/agents/host/AgentHost";
import type { LevelGeometry } from "@/agents/world/levels";

/**
 * The in-game command line: what `\` opens.
 *
 * Nothing typed here is ever said out loud — it is parsed and run. Pure apart
 * from the host it drives, so every command can be tested without a game.
 */

/** The parts of AgentHost the commands use. */
export type AgentControl = Pick<
  AgentHost,
  "spawn" | "despawn" | "findByName" | "snapshot" | "configureJev" | "has"
>;

export interface CommandRoom {
  levelKey: string;
  label: string;
  /** Null while the room's ground is still loading. */
  geometry: LevelGeometry | null;
}

export interface CommandContext {
  host: AgentControl;
  room: CommandRoom;
  /** Where the player stands and faces; null before the first frame. */
  pose: { x: number; z: number; yaw: number } | null;
}

export interface CommandResult {
  ok: boolean;
  lines: string[];
}

/** Short names for the brain models, as typed after `createagent`. */
const MODEL_ALIASES: Record<string, AgentModelName> = {
  claude: "claude-haiku-4-5",
  haiku: "claude-haiku-4-5",
  "claude-haiku-4-5": "claude-haiku-4-5",
  gpt: "gpt-5-mini",
  openai: "gpt-5-mini",
  "gpt-5-mini": "gpt-5-mini",
  gemini: "gemini-2-5-flash",
  flash: "gemini-2-5-flash",
  "gemini-2-5-flash": "gemini-2-5-flash",
};

const COLOURS = ["#00d2ff", "#ff5c8a", "#ffd166", "#00ffb2", "#7a5cff", "#ff8f4d", "#5ce1e6", "#b0ff6b"];
const DEFAULT_PERSONALITY = "Friendly and curious. Likes a chat, and likes building small things.";
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '_-]{0,23}$/u;
/** How far in front of the player a new agent appears. */
const SPAWN_DISTANCE = 3;

export const HELP_LINES = [
  "createagent <claude|gpt|gemini> <name> [personality…]",
  '    e.g. createagent gemini Dave a grumpy old builder who loves bridges',
  '    names with spaces go in quotes: createagent claude "Big Dave" …',
  "agents                      list the AI players you are running",
  "removeagent <name|all>      send an agent home",
  "jevkey <openrouter key|off> give agents fast reflexes (Jev), for this session",
  "help                        this list",
];

/** Splits a line on spaces, keeping "quoted phrases" together. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) != null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function hash(text: string): number {
  let value = 0;
  for (const character of text) {
    value = (value * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return value;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

/** A persona made up on the spot from a name and a line of personality. */
export function makePersona(
  name: string,
  model: AgentModelName,
  personality: string,
  home: [number, number],
): Persona {
  return {
    // Keyed on the name, so a recreated "Dave" remembers who he met.
    id: `custom-${slug(name)}`,
    name,
    persona: `You are ${name}, an AI resident of Dechoverse. ${personality}`,
    model,
    color: COLOURS[hash(name) % COLOURS.length],
    hat: null,
    interests: ["a small lookout tower", "a bench to sit on", "a little hut"],
    home,
  };
}

function fail(...lines: string[]): CommandResult {
  return { ok: false, lines };
}

function createAgent(args: string[], context: CommandContext): CommandResult {
  if (args.length < 2) {
    return fail("Usage: createagent <claude|gpt|gemini> <name> [personality…]");
  }
  const model = MODEL_ALIASES[args[0].toLowerCase()];
  if (model == null) {
    return fail(`Unknown model "${args[0]}". Use claude, gpt or gemini.`);
  }
  const name = args[1].trim();
  if (!NAME_PATTERN.test(name)) {
    return fail(`"${name}" is not a usable name: letters, numbers and spaces, up to 24 characters.`);
  }
  const personality = args.slice(2).join(" ").trim() || DEFAULT_PERSONALITY;

  const { room, pose, host } = context;
  if (room.geometry == null) {
    return fail(`${room.label} is still loading. Try again in a moment.`);
  }
  if (host.findByName(name) != null) {
    return fail(`${name} is already here. Use "removeagent ${name}" first.`);
  }

  const here = pose ?? { x: 0, z: 0, yaw: 0 };
  // In front of the player, in the camera's convention: yaw 0 looks down -Z.
  const home: [number, number] = [
    here.x - Math.sin(here.yaw) * SPAWN_DISTANCE,
    here.z - Math.cos(here.yaw) * SPAWN_DISTANCE,
  ];
  const persona = makePersona(name, model, personality, home);
  if (host.has(persona.id)) {
    return fail(`${name} is already here. Use "removeagent ${name}" first.`);
  }
  host.spawn(persona, {
    model,
    levelKey: room.levelKey,
    hat: null,
    color: persona.color,
    geometry: room.geometry,
  });
  const jev = host.snapshot().jevConfigured;
  return {
    ok: true,
    lines: [
      `${agentUserId(name)} joined ${room.label}, thinking with ${model}.`,
      `Personality: ${personality}`,
      ...(room.geometry.buildable ? [] : ["Nothing can be built in this room, so they will only walk and talk."]),
      ...(jev ? [] : ['No Jev key yet: they answer only when you say their name or stand close. "jevkey <key>" to fix.']),
    ],
  };
}

function listAgents(context: CommandContext): CommandResult {
  const agents = context.host.snapshot().agents;
  if (agents.length === 0) {
    return { ok: true, lines: ['No AI players running. Try "createagent gemini Dave".'] };
  }
  return {
    ok: true,
    lines: agents.map(
      (agent) =>
        `${agent.userId} · ${agent.model} · ${agent.mode.toLowerCase()} · ${
          agent.levelKey === context.room.levelKey ? "here" : agent.levelKey
        }${agent.brain.error != null ? ` · ⚠ ${agent.brain.error}` : ""}`,
    ),
  };
}

function removeAgent(args: string[], context: CommandContext): CommandResult {
  const target = args.join(" ").trim();
  if (target === "") {
    return fail("Usage: removeagent <name|all>");
  }
  if (target.toLowerCase() === "all") {
    const agents = context.host.snapshot().agents;
    for (const agent of agents) {
      context.host.despawn(agent.id);
    }
    return { ok: true, lines: [`Sent ${agents.length} agent${agents.length === 1 ? "" : "s"} home.`] };
  }
  const id = context.host.findByName(target);
  if (id == null) {
    return fail(`No agent called "${target}". "agents" lists them.`);
  }
  context.host.despawn(id);
  return { ok: true, lines: [`${agentUserId(target)} went home.`] };
}

function jevKey(args: string[], context: CommandContext): CommandResult {
  const key = args[0] ?? "";
  if (key === "") {
    const snapshot = context.host.snapshot();
    return {
      ok: true,
      lines: [
        snapshot.jevConfigured
          ? `Jev is on (${snapshot.jevModel}).`
          : snapshot.jevError != null
            ? `Jev stopped: ${snapshot.jevError}`
            : "Jev is off. Usage: jevkey <openrouter key|off>",
      ],
    };
  }
  if (key.toLowerCase() === "off") {
    storeJev("", "");
    context.host.configureJev("", "");
    return { ok: true, lines: ["Jev off: agents fall back to simple rules."] };
  }
  const model = storedJevModel();
  storeJev(key, model);
  context.host.configureJev(key, model);
  return { ok: true, lines: [`Jev on (${model}), for this browser session.`] };
}

/** Runs one line typed into the command line. */
export function runCommand(line: string, context: CommandContext): CommandResult {
  const tokens = tokenize(line.trim().replace(/^[\\/]/, ""));
  if (tokens.length === 0) {
    return { ok: true, lines: [] };
  }
  const [command, ...args] = tokens;
  switch (command.toLowerCase()) {
    case "createagent":
    case "spawn":
      return createAgent(args, context);
    case "agents":
    case "listagents":
      return listAgents(context);
    case "removeagent":
    case "despawn":
      return removeAgent(args, context);
    case "jevkey":
      return jevKey(args, context);
    case "help":
    case "?":
      return { ok: true, lines: HELP_LINES };
    default:
      return fail(`Unknown command "${command}". Type "help" for the list.`);
  }
}
