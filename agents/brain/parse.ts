import {
  type BlueprintCube,
  buildable,
  cubesFromList,
  expandParts,
  readPalette,
} from "@/agents/build/blueprint";
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

/** One cube of a plan: cell offsets within the site, and its colour. */
export type PlannedCube = BlueprintCube;

export interface BuildPlan {
  title: string;
  site: BuildSite;
  palette: string[];
  /** In the order they should be placed: every one touches one placed before. */
  cubes: PlannedCube[];
  /** How many the model proposed that were thrown away, for the console. */
  discarded: number;
}

/** Cubes from a reply's "parts" (shapes) and/or "cubes" (the flat legacy list). */
function proposedCubes(json: Record<string, unknown>, palette: string[]): {
  cubes: Map<string, BlueprintCube>;
  cleared: Set<string>;
} {
  const cubes = Array.isArray(json.cubes) ? cubesFromList(json.cubes, palette) : new Map();
  const cleared = new Set<string>();
  if (Array.isArray(json.parts)) {
    const expansion = expandParts(json.parts, palette);
    for (const [key, cube] of expansion.cubes) {
      cubes.set(key, cube);
    }
    for (const key of expansion.cleared) {
      if (!expansion.cubes.has(key)) {
        cubes.delete(key);
        cleared.add(key);
      }
    }
  }
  return { cubes, cleared };
}

/**
 * A plan, with everything that cannot be built removed.
 *
 * The model picks one of the offered sites by key and describes the building
 * as shapes ("parts"), a cube list, or both. Kept: cubes inside the site,
 * below the layer limit, connected to the ground through other cubes, up to
 * the cube limit — see blueprint.buildable.
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
  const palette = readPalette(json.palette);
  if (palette.length === 0) {
    return null;
  }
  const { cubes: proposed } = proposedCubes(json, palette);
  const { cubes, dropped } = buildable(proposed.values(), site.size, maxCubes);
  if (cubes.length === 0) {
    return null;
  }
  const title =
    typeof json.title === "string" && json.title.trim() !== ""
      ? json.title.trim().slice(0, 80)
      : "something";
  return { title, site, palette, cubes, discarded: dropped };
}

export interface ParsedReview {
  done: boolean;
  /** More cubes, ordered for building on top of what stands. */
  add: PlannedCube[];
  /**
   * Cells to empty: queued cubes are dropped, and placed ones erased — only
   * ever this build's own; the caller checks.
   */
  remove: string[];
  palette: string[];
  note: string;
  discarded: number;
}

/**
 * The model's look at a build in progress: carry on (with more parts), take
 * something out (clear parts), or call it done.
 *
 * `standing` is what is on the site now, keyed by cell, and `queued` what
 * the plan will still add; new cubes may rest on either, since they are
 * built after the queue. Clears apply to both.
 */
export function parseReview(
  text: string,
  size: number,
  palette: string[],
  standing: Set<string>,
  maxCubes: number,
  queued: Set<string> = new Set(),
): ParsedReview | null {
  const json = extractJsonObject(text);
  if (json == null) {
    return null;
  }
  // New colours may be added; indices past the old palette refer to them.
  const extra = readPalette(json.palette).filter((color) => !palette.includes(color));
  const fullPalette = [...palette, ...extra].slice(0, 6);
  const { cubes: proposed, cleared } = proposedCubes(json, fullPalette);
  const remove = [...cleared].filter((key) => standing.has(key) || queued.has(key));
  const remaining = new Set(
    [...standing, ...queued].filter((key) => !cleared.has(key)),
  );
  const { cubes, dropped } = buildable(proposed.values(), size, maxCubes, remaining);
  const done = json.status === "done";
  return {
    done,
    add: done ? [] : cubes,
    remove,
    palette: fullPalette,
    note: typeof json.note === "string" ? json.note.slice(0, 200) : "",
    discarded: done ? 0 : dropped,
  };
}
