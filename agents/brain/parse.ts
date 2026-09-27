import type { BuildSite, ReplyAction } from "@/agents/brain/prompts";

/**
 * Reading what the brain queries returned.
 *
 * The queries return the model's text exactly as it came, so everything here
 * assumes the worst: code fences it was told not to use, prose around the
 * JSON, keys that were never offered, cubes in mid air. Anything not on the
 * list the prompt offered is discarded — a model can choose badly, but it
 * cannot make an agent do something the game did not allow.
 *
 * An empty string means the query went unanswered (the model was unreachable
 * or said nothing), and every parser returns null for it.
 */

/** Longest line an agent may say. Matches MAX_MESSAGE_LENGTH in speech.ts. */
export const MAX_SAY_LENGTH = 200;

/** The first JSON object in the text, or null. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  if (text.trim() === "") {
    return null;
  }
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Speech, not text: no markdown, no line breaks, no runaway length. */
export function cleanSpeech(text: string): string {
  const flattened = text
    .replace(/[*_`#>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flattened.length <= MAX_SAY_LENGTH) {
    return flattened;
  }
  // Cut at the last sentence or word boundary that fits, rather than mid-word.
  const cut = flattened.slice(0, MAX_SAY_LENGTH);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence > MAX_SAY_LENGTH * 0.5) {
    return cut.slice(0, sentence + 1);
  }
  const word = cut.lastIndexOf(" ");
  return `${cut.slice(0, word > 0 ? word : MAX_SAY_LENGTH - 1)}…`;
}

export interface ParsedReply {
  say: string;
  /** The key answered, or "none" for an unprompted greeting. */
  replyTo: string;
  remember: string | null;
  /** What to do as well as speak; "none" when missing or not on offer. */
  action: ReplyAction;
  /** For "build": what to build, in the model's words. */
  build: string | null;
}

export function parseReply(
  text: string,
  allowedKeys: string[],
  allowedActions: ReplyAction[] = ["none"],
): ParsedReply | null {
  const json = extractJsonObject(text);
  if (json == null || typeof json.say !== "string") {
    return null;
  }
  const say = cleanSpeech(json.say);
  if (say === "") {
    return null;
  }
  const replyTo = typeof json.replyTo === "string" ? json.replyTo.trim() : "";
  const allowed = allowedKeys.length === 0 ? ["none"] : allowedKeys;
  if (!allowed.includes(replyTo)) {
    return null;
  }
  const remember =
    typeof json.remember === "string" && json.remember.trim() !== ""
      ? json.remember.trim().slice(0, 200)
      : null;
  // An action that was not offered is ignored, not obeyed: the words still stand.
  const action =
    typeof json.action === "string" && (allowedActions as string[]).includes(json.action)
      ? (json.action as ReplyAction)
      : "none";
  const build =
    typeof json.build === "string" && json.build.trim() !== "" ? json.build.trim().slice(0, 120) : null;
  return { say, replyTo, remember, action, build };
}

export interface ParsedDecision {
  choice: string;
  why: string;
}

export function parseDecide(text: string, allowedKeys: string[]): ParsedDecision | null {
  const json = extractJsonObject(text);
  if (json == null || typeof json.choice !== "string") {
    return null;
  }
  const choice = json.choice.trim();
  if (!allowedKeys.includes(choice)) {
    return null;
  }
  return { choice, why: typeof json.why === "string" ? json.why.slice(0, 300) : "" };
}

/** One cube of a plan, in world cell coordinates, with its colour. */
export interface PlannedCube {
  /** Cell offsets within the site; y is layers above that column's ground. */
  dx: number;
  dy: number;
  dz: number;
  color: string;
}

export interface BuildPlan {
  title: string;
  site: BuildSite;
  /** Bottom-up, in the order they should be placed. */
  cubes: PlannedCube[];
  /** How many the model proposed that were thrown away, for the console. */
  discarded: number;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Taller than this is a model getting carried away. */
const MAX_LAYERS = 12;

/**
 * A plan, with everything invalid removed.
 *
 * Kept: cubes inside the chosen site, within MAX_LAYERS, with a real palette
 * colour, resting on the ground or on another kept cube. Support is checked
 * after dropping the rest, so a column whose base was invalid loses
 * everything above it too rather than leaving it floating.
 */
export function parsePlan(text: string, sites: BuildSite[], maxCubes: number): BuildPlan | null {
  const json = extractJsonObject(text);
  if (json == null) {
    return null;
  }
  const site = sites.find((candidate) => candidate.key === json.site);
  if (site == null) {
    return null;
  }
  const palette = Array.isArray(json.palette)
    ? json.palette.filter((color): color is string => typeof color === "string" && HEX.test(color))
    : [];
  if (palette.length === 0 || !Array.isArray(json.cubes)) {
    return null;
  }

  const proposed = json.cubes.length;
  const occupied = new Set<string>();
  const candidates: PlannedCube[] = [];
  for (const entry of json.cubes) {
    if (!Array.isArray(entry) || entry.length < 4) {
      continue;
    }
    const [dx, dy, dz, colorIndex] = entry.map(Number);
    if (![dx, dy, dz, colorIndex].every(Number.isInteger)) {
      continue;
    }
    if (dx < 0 || dz < 0 || dx >= site.size || dz >= site.size || dy < 0 || dy >= MAX_LAYERS) {
      continue;
    }
    const color = palette[colorIndex];
    if (color == null) {
      continue;
    }
    const key = `${dx},${dy},${dz}`;
    if (occupied.has(key)) {
      continue;
    }
    occupied.add(key);
    candidates.push({ dx, dy, dz, color });
  }

  // Keep only what is supported, working upwards so support can chain.
  candidates.sort((a, b) => a.dy - b.dy);
  const kept = new Set<string>();
  const cubes: PlannedCube[] = [];
  for (const cube of candidates) {
    const supported = cube.dy === 0 || kept.has(`${cube.dx},${cube.dy - 1},${cube.dz}`);
    if (!supported || cubes.length >= maxCubes) {
      continue;
    }
    kept.add(`${cube.dx},${cube.dy},${cube.dz}`);
    cubes.push(cube);
  }
  if (cubes.length === 0) {
    return null;
  }

  const title =
    typeof json.title === "string" && json.title.trim() !== ""
      ? json.title.trim().slice(0, 80)
      : "something";
  return { title, site, cubes, discarded: proposed - cubes.length };
}
