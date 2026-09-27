/**
 * The prompts sent to the brain queries in llmfunctions/.
 *
 * Pure: everything a prompt needs is passed in, and every answer the model
 * may give is listed in it by key — which message to answer, which site to
 * build on, which option to take. parse.ts then discards anything that is
 * not on those lists. The queries add only the brief and the persona.
 */

export interface PromptMessage {
  /** Short key the model answers with: m1, m2, … */
  key: string;
  from: string;
  fromKind: "human" | "ai";
  text: string;
  secondsAgo: number;
  distance: number | null;
}

export interface PromptPerson {
  name: string;
  kind: "human" | "ai";
  distance: number;
}

export interface ConversationLine {
  speaker: string;
  text: string;
}

/**
 * What an agent may do as well as speak. The reply names one, and the game
 * carries it out — which is how "go and build something" becomes a build
 * rather than just a sentence about one.
 */
export type ReplyAction = "none" | "build" | "follow" | "stay" | "explore" | "stop_building";

export const REPLY_ACTIONS: Record<ReplyAction, string> = {
  none: "just talk; carry on as you were",
  build: 'start building something now; say what in "build", e.g. "a small stone bridge"',
  follow: "walk along with the person you are answering",
  stay: "stop following and stay where you are",
  explore: "wander off on your own",
  stop_building: "give up on what you are building",
};

export interface ReplyPromptInput {
  agentName: string;
  goal: string | null;
  building: string | null;
  /** Messages the agent may answer, newest last. Empty for an unprompted greeting. */
  messages: PromptMessage[];
  /** For an unprompted greeting: who to greet. */
  greet: string | null;
  people: PromptPerson[];
  conversation: ConversationLine[];
  memories: string[];
  /** The actions on offer right now; "build" only where building is allowed. */
  actions: ReplyAction[];
}

function metres(distance: number | null): string {
  return distance == null ? "nearby" : `${Math.round(distance)} m away`;
}

export function buildReplyPrompt(input: ReplyPromptInput): string {
  const lines: string[] = [];
  lines.push(`You are ${input.agentName}.`);
  lines.push(
    input.goal != null ? `Your current goal: ${input.goal}.` : "You have no particular goal right now.",
  );
  if (input.building != null) {
    lines.push(`You are in the middle of building: ${input.building}.`);
  }
  lines.push("");

  lines.push("PEOPLE NEAR YOU");
  if (input.people.length === 0) {
    lines.push("(nobody)");
  }
  for (const person of input.people) {
    lines.push(`- ${person.name} (${person.kind === "ai" ? "another AI" : "human"}), ${metres(person.distance)}`);
  }
  lines.push("");

  if (input.memories.length > 0) {
    lines.push("WHAT YOU REMEMBER");
    for (const memory of input.memories) {
      lines.push(`- ${memory}`);
    }
    lines.push("");
  }

  if (input.conversation.length > 0) {
    lines.push("THE CONVERSATION SO FAR (oldest first)");
    for (const line of input.conversation) {
      lines.push(`${line.speaker}: ${line.text}`);
    }
    lines.push("");
  }

  if (input.messages.length > 0) {
    lines.push("MESSAGES YOU MAY ANSWER (answer exactly one, by id)");
    for (const message of input.messages) {
      const who = message.fromKind === "ai" ? `${message.from} (another AI)` : message.from;
      lines.push(
        `[${message.key}] ${who}, ${metres(message.distance)}, ${Math.round(message.secondsAgo)} s ago: "${message.text}"`,
      );
    }
  } else if (input.greet != null) {
    lines.push("MESSAGES YOU MAY ANSWER");
    lines.push("(none — nobody has spoken to you)");
    lines.push("");
    lines.push(
      `${input.greet} has just come near you. Say hello in your own way, and use "none" as replyTo.`,
    );
  }

  lines.push("");
  lines.push('ACTIONS (put exactly one in "action"; if someone asks you to do something, do it)');
  for (const action of input.actions) {
    lines.push(`- ${action}: ${REPLY_ACTIONS[action]}`);
  }
  lines.push("");
  lines.push(
    'Reply with JSON only, on one line: {"say":"...","replyTo":"<id>","remember":null,"action":"none","build":null}',
  );

  return lines.join("\n");
}

/** A patch of flat, empty ground the agent could build on. */
export interface BuildSite {
  key: string;
  /** Cell coordinates of the corner (dx = dz = 0). */
  cellX: number;
  cellZ: number;
  size: number;
  distance: number;
  description: string;
}

export interface PlanPromptInput {
  agentName: string;
  goal: string;
  sites: BuildSite[];
  /** Colours of cubes already nearby, most common first. */
  nearbyColors: string[];
  maxCubes: number;
}

export function buildPlanPrompt(input: PlanPromptInput): string {
  const lines: string[] = [];
  lines.push(`You are ${input.agentName}. You want to build: ${input.goal}.`);
  lines.push("");
  lines.push("SITES YOU MAY BUILD ON (choose exactly one, by key)");
  for (const site of input.sites) {
    lines.push(
      `[${site.key}] ${site.size}×${site.size} cells, ${Math.round(site.distance)} m away — ${site.description}`,
    );
  }
  lines.push("");
  lines.push(
    input.nearbyColors.length > 0
      ? `COLOURS ALREADY NEARBY: ${input.nearbyColors.join(", ")}`
      : "COLOURS ALREADY NEARBY: none — the area is untouched.",
  );
  lines.push("");
  lines.push(`At most ${input.maxCubes} cubes.`);
  return lines.join("\n");
}

export interface DecideOption {
  key: string;
  label: string;
}

export interface DecidePromptInput {
  agentName: string;
  question: string;
  situation: string[];
  options: DecideOption[];
}

export function buildDecidePrompt(input: DecidePromptInput): string {
  const lines: string[] = [];
  lines.push(`You are ${input.agentName}.`);
  lines.push("");
  lines.push("THE SITUATION");
  for (const line of input.situation) {
    lines.push(`- ${line}`);
  }
  lines.push("");
  lines.push(`THE DECISION: ${input.question}`);
  lines.push("");
  lines.push("OPTIONS (choose exactly one key)");
  for (const option of input.options) {
    lines.push(`[${option.key}] ${option.label}`);
  }
  return lines.join("\n");
}
