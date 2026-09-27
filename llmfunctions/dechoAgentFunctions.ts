/**
 * DECHOVERSE AGENT BRAINS
 *
 * The language model behind each AI resident of Dechoverse, exposed as
 * Queries so the Dechoverse app can execute them through its OSDK.
 *
 * ⚠ THIS FOLDER IS NOT PART OF THE APP BUILD. It is copied into a TypeScript
 * v1 functions repository (functions-typescript/src/) and published from
 * there. The `@foundry/*` imports only resolve inside that repository.
 *
 * WHERE THAT REPOSITORY MUST SIT
 *
 * On the ACCENTURE ONTOLOGY — the one the app's generated SDK
 * (@ap-homepage/sdk) was made against. A query is resolved by api name WITHIN
 * an ontology, and the app's OSDK client is created with that SDK's
 * `$ontologyRid`. Anywhere else gives, in order: a 404 QueryNotFound for a
 * query with no api name, an Ontology import requirement once it has one, and
 * ViewOntologyPermissionDenied when the repository has no rights over the
 * app's ontology. (All three were learned the hard way on BGWS.)
 *
 * After publishing: tag a release (api-named queries run the latest tagged
 * version), add the four queries to the app's Ontology SDK resources in
 * Developer Console, and generate a new SDK version so they appear in
 * @ap-homepage/sdk.
 *
 * WHAT THIS FUNCTION DELIBERATELY DOES NOT DO
 *
 * Know the world. It is a thin pipe: prompt in, raw completion out. The app
 * (agents/brain/prompts.ts and parse.ts) builds every prompt, lists every
 * legal answer — which message to answer, which build site, which option —
 * and DISCARDS anything the model returns that is not on the list. A model
 * can therefore only choose badly, never cheat; the prompts and parsers are
 * unit tested without calling a model; and swapping models is a parameter.
 *
 * WHY FIVE QUERIES
 *
 *   dechoAgentReply   one spoken line, answering one of the messages listed,
 *                     plus an action (build, follow, stay …) the game carries out.
 *   dechoAgentPlan    a small build, in shapes, on one of the sites listed.
 *   dechoAgentReview  a look at a build in progress, drawn layer by layer:
 *                     carry on with more parts, take cubes out, or finish.
 *   dechoAgentDecide  one decision the fast reflex model (Jev) was unsure
 *                     about, or the choice of a new goal, from keyed options.
 *   dechoAgentModels  the models accepted, for the app's picker.
 *
 * Separate queries rather than a flag on one, because the brief is what
 * differs and the brief is what a reader of this file needs to see.
 *
 * WHY NOT TEMPERATURE 0 EVERYWHERE
 *
 * Unlike a wargame commander, a resident that says the same line to every
 * greeting feels dead. Speech is warm, plans are moderate, and escalated
 * decisions stay at 0 because they stand in for a reflex that should be
 * consistent.
 */

import { Query, UserFacingError } from "@foundry/functions-api";
// Model imports are added through Resource Imports, not by hand. ⚠ The three
// identifiers below are the expected names; if the Resource Imports sidebar
// shows different ones, rename them here and in `run` — nothing else changes.
import {
  AnthropicClaude_4_5_Haiku,
  GPT_5_4_mini,
  Gemini_3_6_Flash,
} from "@foundry/models-api/language-models";

/**
 * Which model thinks for an agent. A narrow union rather than a free model
 * name, so an unknown value fails loudly at the boundary instead of silently
 * falling back to a default nobody chose. Kept in step by hand with
 * AGENT_MODELS in the app's agents/data/brainClient.ts.
 */
export type AgentModel =
  | "claude-haiku-4-5"
  | "gpt-5-4-mini"
  | "gemini-3-6-flash";

const MODELS: AgentModel[] = [
  "claude-haiku-4-5",
  "gpt-5-4-mini",
  "gemini-3-6-flash",
];

const TEMPERATURE_REPLY = 0.8;
const TEMPERATURE_PLAN = 0.4;
const TEMPERATURE_DECIDE = 0;

/**
 * One ceiling per brief, shared by every model rather than tuned per model.
 * GPT-5.4 mini reasons before answering and may count that hidden reasoning
 * against the limit, so its number is the one that has to cover a reply cut
 * short as unreadable JSON; Claude and Gemini simply inherit the same
 * headroom rather than each carrying their own tuned figure.
 */
const MAX_TOKENS_REPLY = 2500;

/** Up to 200 cubes at a dozen characters each, plus the envelope. */
const MAX_TOKENS_PLAN = 8000;

/** A single key and one sentence. */
const MAX_TOKENS_DECIDE = 2000;

/** A look at a build: a note and a few parts, or "done". */
const MAX_TOKENS_REVIEW = 4000;

const WORLD = [
  "Dechoverse is a shared 3D world. People walk about, talk out loud to whoever",
  "is near them, and build things out of one-metre coloured cubes. You are one",
  "of its residents: an AI, with your own name and character, living there",
  "alongside the humans.",
].join("\n");

const REPLY_BRIEF = [
  WORLD,
  "",
  "Someone near you has said something. You are about to speak out loud.",
  "",
  "- Say one or two short sentences, at most 200 characters. It is speech, not text:",
  "  no lists, no emoji strings, no markdown.",
  "- Stay in character. Be friendly, curious and a little playful.",
  "- If someone asks directly whether you are an AI, say so honestly.",
  "- Never say anything hateful, sexual or cruel, and do not repeat it if asked to.",
  "- Answer exactly ONE of the messages listed, by its id (m1, m2, ...). Prefer",
  "  the one most clearly addressed to you.",
  "- If you learn something worth remembering about the person — their name for",
  '  something, what they like, what they are building — put it in "remember" as',
  "  one short sentence about them. Otherwise null.",
  "- You can act as well as talk. Put exactly one of the ACTIONS listed below in",
  '  "action". If someone asks you to build, follow, stay or go off exploring,',
  "  agree in words AND choose that action — words alone do nothing. For",
  '  "build", say what in "build" (e.g. "a small stone bridge"); otherwise null.',
  "",
  "Reply with JSON only, on one line:",
  '{"say":"...","replyTo":"m1","remember":null,"action":"none","build":null}',
  "No prose, no code fences, nothing outside the JSON.",
].join("\n");

const PLAN_BRIEF = [
  WORLD,
  "",
  "You are going to build something small with cubes. Design it.",
  "",
  "- Choose exactly ONE of the sites listed, by its key. Positions are cells from",
  "  the site's corner: x and z from 0 to size-1, y = layers above the ground",
  "  (0 = resting on it).",
  "- Describe it in shapes (\"parts\"): wall, floor, box, pillar, roof, arch, clear",
  "  and cube, as listed in the prompt. Use clear, after the part it cuts into,",
  "  for doors and windows. The game turns the parts into cubes.",
  "- Every cube must connect to the ground through other cubes, above, below or",
  "  beside. Anything unconnected is discarded.",
  "- Smaller and recognisable beats large and shapeless: a hut, a tower, an arch,",
  "  a bench, a bridge, a tree, a little wall with a gate. You will get to look at",
  "  it as it goes up and add to it, so the first plan can be the main structure.",
  "- Up to four colours as #rrggbb hex; parts name a colour by palette index in",
  '  "c". Colours that suit the ones already nearby are nicer to live with.',
  "",
  "Reply with JSON only, on one line:",
  '{"title":"...","site":"<key>","palette":["#rrggbb"],"parts":[...]}',
  "No prose, no code fences, nothing outside the JSON.",
].join("\n");

const REVIEW_BRIEF = [
  WORLD,
  "",
  "You are part way through a build. The prompt draws what is actually standing",
  "on your site, one grid per layer, top layer first. Look at it the way a builder",
  "steps back from a wall.",
  "",
  "- If it is turning out as you meant, carry on — or add what it still needs.",
  "- If something is wrong, take it out with clear parts and put it right.",
  '- If it is finished, say "done". Stopping at the right time is part of it.',
  "- New parts may rest on what is already standing. The same shapes as before.",
  "",
  "Reply with JSON only, on one line:",
  '{"status":"continue|done","note":"<one sentence>","palette":["#rrggbb"],"parts":[...]}',
  '("palette" only for colours you have not used yet.) No prose, no code fences.',
].join("\n");

const DECIDE_BRIEF = [
  WORLD,
  "",
  "Your fast reflexes were unsure about the decision below and have passed it",
  "to you. You are standing still until you answer, so be quick.",
  "",
  "Choose exactly one of the option keys given. A key that was not offered is",
  "ignored and your reflexes decide instead.",
  "",
  'Reply with JSON only, on one line: {"choice":"<key>","why":"<one sentence>"}',
].join("\n");

export class DechoAgentFunctions {
  /**
   * One spoken line.
   *
   * ⚠ @Query, NOT @Function. `@Function()` registers a function for use
   * inside Foundry only and publishes nothing on the API gateway, so the app
   * would get a bare 400. Only @Query creates an endpoint an application can
   * execute. The api names are prefixed because they must be unique across
   * every imported Ontology.
   *
   * @param prompt Who said what, who is near, the agent's goal and memories.
   *   Built by the app; see agents/brain/prompts.ts.
   * @param model Which model thinks for this agent.
   * @param persona The agent's name and character.
   */
  @Query({ apiName: "dechoAgentReply" })
  public async dechoAgentReply(
    prompt: string,
    model: string,
    persona: string
  ): Promise<string> {
    this.requirePrompt(
      prompt,
      "No conversation was supplied, so there is nothing to answer."
    );
    const chosen = this.modelFor(model);
    return this.run(
      chosen,
      this.compose(REPLY_BRIEF, persona, prompt),
      TEMPERATURE_REPLY,
      MAX_TOKENS_REPLY
    );
  }

  /** A small build on one of the sites the app offers. */
  @Query({ apiName: "dechoAgentPlan" })
  public async dechoAgentPlan(
    prompt: string,
    model: string,
    persona: string
  ): Promise<string> {
    this.requirePrompt(
      prompt,
      "No sites were supplied, so there is nowhere to build."
    );
    const chosen = this.modelFor(model);
    return this.run(
      chosen,
      this.compose(PLAN_BRIEF, persona, prompt),
      TEMPERATURE_PLAN,
      MAX_TOKENS_PLAN
    );
  }

  /**
   * One decision, from keyed options.
   *
   * Reply: {"choice":"<key>","why":"..."}. An empty or unreadable reply is
   * not an error: the app lets the reflex answer stand and records that it
   * did.
   */
  @Query({ apiName: "dechoAgentDecide" })
  public async dechoAgentDecide(
    prompt: string,
    model: string,
    persona: string
  ): Promise<string> {
    this.requirePrompt(
      prompt,
      "No decision was supplied, so there is nothing to decide."
    );
    const chosen = this.modelFor(model);
    return this.run(
      chosen,
      this.compose(DECIDE_BRIEF, persona, prompt),
      TEMPERATURE_DECIDE,
      MAX_TOKENS_DECIDE
    );
  }

  /**
   * A look at a build in progress.
   *
   * Optional for the app: without it published, builds go up exactly as
   * first planned. Reply: {"status","note","palette","parts"}; an empty or
   * unreadable reply counts as a look that changed nothing.
   */
  @Query({ apiName: "dechoAgentReview" })
  public async dechoAgentReview(
    prompt: string,
    model: string,
    persona: string
  ): Promise<string> {
    this.requirePrompt(
      prompt,
      "No build was supplied, so there is nothing to look at."
    );
    const chosen = this.modelFor(model);
    return this.run(
      chosen,
      this.compose(REVIEW_BRIEF, persona, prompt),
      TEMPERATURE_PLAN,
      MAX_TOKENS_REVIEW
    );
  }

  /** Every model these queries accept, for the app's picker. */
  @Query({ apiName: "dechoAgentModels" })
  public dechoAgentModels(): string[] {
    return MODELS.slice();
  }

  /** Loud, not empty: an empty prompt would get a confident answer about nothing. */
  private requirePrompt(prompt: string, message: string): void {
    if (!prompt || prompt.trim().length === 0) {
      throw new UserFacingError(message);
    }
  }

  /** A known model, or a loud error naming the ones that are. */
  private modelFor(model: string): AgentModel {
    const chosen = MODELS.find((candidate) => candidate === model);
    if (chosen === undefined) {
      throw new UserFacingError(
        `Unknown agent model "${model}". Available: ${MODELS.join(", ")}.`
      );
    }
    return chosen;
  }

  /**
   * Brief, persona and prompt, as one user turn.
   *
   * Prepended to the user turn rather than sent as a SYSTEM message, because
   * the imported models disagree about how a system role is shaped and this
   * function is not the place to care.
   */
  private compose(brief: string, persona: string, prompt: string): string {
    const system =
      persona && persona.trim().length > 0
        ? `${brief}\n\nWHO YOU ARE\n\n${persona.trim()}`
        : brief;
    return `${system}\n\n---\n\n${prompt}`;
  }

  /**
   * Ask the chosen model, and return its reply as it came.
   *
   * ⚠ AN EMPTY REPLY IS RETURNED EMPTY, not dressed up as JSON. The app reads
   * "" as unanswered — the agent simply stays quiet and the failure is
   * counted — whereas a made-up {"say":""} would read as a resident who chose
   * to ignore someone, which hides an unreachable model behind a shy one.
   */
  private async run(
    chosen: AgentModel,
    content: string,
    temperature: number,
    maxTokens: number
  ): Promise<string> {
    let completion: string | undefined;
    if (chosen === "claude-haiku-4-5") {
      completion = await this.askClaude(content, temperature, maxTokens);
    } else if (chosen === "gpt-5-4-mini") {
      completion = await this.askGpt(content, temperature, maxTokens);
    } else {
      completion = await this.askGemini(content, temperature, maxTokens);
    }
    return completion === undefined ? "" : completion;
  }

  /**
   * The imported models do NOT share a response shape, which is why each gets
   * its own method rather than one generic call. Claude and Gemini return
   * `completion`; GPT returns `choices[0].message.content`. Casting over that
   * would move the breakage from compile time to the middle of a conversation.
   */
  private async askClaude(
    content: string,
    temperature: number,
    maxTokens: number
  ): Promise<string | undefined> {
    const response =
      await AnthropicClaude_4_5_Haiku.createGenericChatCompletion({
        params: { temperature, maxTokens },
        messages: [{ role: "USER", contents: [{ text: content }] }],
      });
    return response.completion;
  }

  private async askGpt(
    content: string,
    temperature: number,
    maxTokens: number
  ): Promise<string | undefined> {
    const response = await GPT_5_4_mini.createChatCompletion({
      params: { temperature, maxTokens },
      messages: [{ role: "USER", contents: [{ text: content }] }],
    });
    return response.choices.length > 0
      ? response.choices[0].message.content
      : undefined;
  }

  private async askGemini(
    content: string,
    temperature: number,
    maxTokens: number
  ): Promise<string | undefined> {
    const response = await Gemini_3_6_Flash.createGenericChatCompletion({
      params: { temperature, maxTokens },
      messages: [{ role: "USER", contents: [{ text: content }] }],
    });
    return response.completion;
  }
}
