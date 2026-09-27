// ── agents/data/brainClient.ts ─────────────────────────────────────────────
// The one impure function behind an agent's language model.
//
// agents/brain/prompts.ts builds the prompt and parse.ts reads the reply, both
// pure and tested without a model. All they need from the outside world is a
// `(prompt) => Promise<string>`. This provides it, by executing one of the
// published queries in llmfunctions/ through the generated OSDK.
//
// ⚠ QUERIES ARE ONTOLOGY-SCOPED. The endpoint is
// /v2/ontologies/{ontology}/queries/{name}/execute — the ONTOLOGIES service —
// not /v2/functions/queries/{name}/execute, whose 404 QueryNotFound reads
// exactly like a function that was never published. Going through the
// generated OSDK means the ontology, api name and parameters cannot be wrong.

import type { QueryDefinition } from "@osdk/client";
import * as sdk from "@ap-homepage/sdk";
import { ontologyClient } from "@/foundry/client";
import { describeApiError } from "@/foundry/errors";

/** Models the published queries accept. Kept in step with llmfunctions by hand. */
export const AGENT_MODELS = ["claude-haiku-4-5", "gpt-5-4-mini", "gemini-3-6-flash"] as const;

export type AgentModelName = (typeof AGENT_MODELS)[number];

export function isAgentModel(value: string): value is AgentModelName {
  return (AGENT_MODELS as readonly string[]).includes(value);
}

/** What prompts.ts and parse.ts need from a model: text in, raw text out. */
export type ModelCall = (prompt: string) => Promise<string>;

/**
 * Which published query a call goes to. See llmfunctions/ for the briefs.
 *
 *   reply   one spoken line
 *   plan    a small cube build on an offered site
 *   decide  one escalated or goal decision from keyed options
 */
export type BrainQueryKind = "reply" | "plan" | "decide" | "review";

export const QUERY_NAMES: Record<BrainQueryKind, string> = {
  reply: "dechoAgentReply",
  plan: "dechoAgentPlan",
  decide: "dechoAgentDecide",
  // A look at a build in progress. Optional: without it, builds go up as
  // first planned and are never revisited.
  review: "dechoAgentReview",
};

/** Whether the installed SDK has this query at all. */
export function hasQuery(kind: BrainQueryKind): boolean {
  return (sdk as unknown as Record<string, unknown>)[QUERY_NAMES[kind]] != null;
}

export class BrainCallError extends Error {
  constructor(
    message: string,
    /** True when it looks like a missing scope or resource grant, not a bug. */
    readonly permissionDenied: boolean,
  ) {
    super(message);
    this.name = "BrainCallError";
  }
}

/**
 * The query to call, looked up in the generated SDK by name.
 *
 * ⚠ LOOKED UP BY NAME, NOT IMPORTED, ON PURPOSE. A named import of a query the
 * SDK does not have yet fails the BUILD, which would make the whole app —
 * not just the agents — unbuildable in the gap between merging this and
 * publishing the functions and regenerating @ap-homepage/sdk. Looked up at
 * runtime, the console says what is missing and everything else works.
 */
function queryFor(kind: BrainQueryKind): { query: QueryDefinition<unknown>; name: string } {
  const name = QUERY_NAMES[kind];
  const found = (sdk as unknown as Record<string, unknown>)[name];
  if (found == null) {
    throw new BrainCallError(
      `${name} is not in @ap-homepage/sdk yet. Publish llmfunctions/ in the functions ` +
        "repository, add the query to this app in Developer Console, and regenerate the SDK.",
      false,
    );
  }
  return { query: found as QueryDefinition<unknown>, name };
}

/** Which brain queries the installed SDK has, for the console's readiness check. */
export function availableQueries(): Record<BrainQueryKind, boolean> {
  return {
    reply: hasQuery("reply"),
    plan: hasQuery("plan"),
    decide: hasQuery("decide"),
    review: hasQuery("review"),
  };
}

function looksLikePermissionProblem(error: unknown): boolean {
  const text = `${String((error as { message?: string })?.message ?? error ?? "")} ${String(
    (error as { errorName?: string })?.errorName ?? "",
  )}`;
  return /permission|denied|403|forbidden|scope|unauthor/i.test(text);
}

/**
 * A ModelCall that runs one published brain query.
 *
 * The model and persona are bound here rather than passed per call, because
 * an agent's brain does not change mid-conversation and the prompt builders
 * should not have to know about either.
 */
export function foundryModelCall(
  model: AgentModelName,
  persona: string,
  kind: BrainQueryKind,
): ModelCall {
  return async (prompt: string): Promise<string> => {
    const { query, name } = queryFor(kind);
    let result: unknown;
    try {
      // The definition is only known at runtime, so the call is typed loosely
      // here; the query's own contract is (prompt, model, persona) → string.
      const execute = ontologyClient(query as QueryDefinition<never>) as unknown as {
        executeFunction: (parameters: Record<string, string>) => Promise<unknown>;
      };
      result = await execute.executeFunction({ prompt, model, persona });
    } catch (error) {
      // The function threw a UserFacingError (HTTP 409): its own words, in
      // parameters.message, are the whole story — show them, not the status.
      const detail = error as { errorName?: unknown; parameters?: { message?: unknown } };
      if (detail?.errorName === "QueryEncounteredUserFacingError") {
        throw new BrainCallError(
          `${name} refused: ${String(detail.parameters?.message ?? "no message")}`,
          false,
        );
      }
      const denied = looksLikePermissionProblem(error);
      throw new BrainCallError(
        denied
          ? `No access to the "${name}" query. Add the Dechoverse Agent Brains functions as a ` +
            "permitted resource on this app in Developer Console, and check the " +
            "api:ontologies-read scope."
          : `Brain query ${name} failed: ${describeApiError(error)}`,
        denied,
      );
    }

    if (typeof result !== "string") {
      // The query's contract is a string. Anything else means the published
      // version and this caller have drifted, which is worth saying plainly
      // rather than coercing into a reply the parser will reject.
      throw new BrainCallError(
        `Expected a string from ${name}, got ${typeof result}. ` +
          "The published query and this caller may have drifted.",
        false,
      );
    }
    // "" is a real answer meaning "unanswered"; parse.ts treats it as such.
    return result;
  };
}
