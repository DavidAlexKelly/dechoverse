/**
 * Jev, TypeSafe AI's "System One" model, reached through OpenRouter.
 *
 * Jev never writes text. One request carries a `state` and a map of named,
 * typed questions, and every question is answered in a single parallel pass:
 *
 *   noul    probability that a statement is true           { noul }
 *   choice  one label out of up to 255                      { choice, confidence?, probabilities? }
 *   score   a position on an ordered 2–10 level rubric      { score, confidence?, legend?, probabilities? }
 *
 * ⚠ NOT CHAT COMPLETIONS. OpenRouter serves Jev on its Decisions API,
 * POST /api/alpha/decisions, and says outright that chat-completions clients
 * will not work with it. The answers come back at the top level, not in
 * choices[0].message.content.
 *
 * A plain fetch rather than the official SDK, which refuses to run in a
 * browser and would add retries this layer does not want: a reflex answered
 * late is worse than one not answered at all.
 */

export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

/**
 * Pinned rather than "~typesafe/jev-latest", so a new Jev release cannot
 * quietly change how every agent behaves. Overridable from the console.
 */
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";

/** A late System-1 answer is worthless; give up rather than wait. */
const TIMEOUT_MS = 2500;

type Entry = string | Record<string, unknown> | unknown[] | null;

export type JevQuestion =
  | { type: "noul"; instructions?: Entry; criteria?: { true?: Entry; false?: Entry } | null }
  | { type: "choice"; instructions?: Entry; criteria: Record<string, Entry> }
  | { type: "score"; instructions?: Entry; criteria: Entry[] };

export type JevQuestions = Record<string, JevQuestion>;

export type JevAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      confidence?: number;
      legend?: Record<string, unknown>;
      probabilities?: Record<string, number>;
    };

export interface JevResult {
  id: string | null;
  model: string | null;
  answers: Record<string, JevAnswer>;
  inputTokens: number;
  /** Dollars, as OpenRouter reports it; 0 when it does not. */
  cost: number;
  latencyMs: number;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Seconds to wait before trying again, from Retry-After. */
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "JevError";
  }

  /** Out of OpenRouter credits: nothing will work until someone tops up. */
  get outOfCredits(): boolean {
    return this.status === 402;
  }

  /** The key is wrong or revoked. */
  get unauthorised(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface JevClient {
  ask: (
    state: unknown,
    questions: JevQuestions,
    options?: { user?: string; signal?: AbortSignal },
  ) => Promise<JevResult>;
}

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

function retryAfter(response: Response): number | null {
  const ms = response.headers.get("retry-after-ms");
  if (ms != null && Number.isFinite(Number(ms))) {
    return Number(ms);
  }
  const seconds = response.headers.get("retry-after");
  if (seconds != null && Number.isFinite(Number(seconds))) {
    return Number(seconds) * 1000;
  }
  return null;
}

/** Keeps only answers of a shape this code understands. */
function readAnswers(raw: unknown): Record<string, JevAnswer> {
  const answers: Record<string, JevAnswer> = {};
  if (raw == null || typeof raw !== "object") {
    return answers;
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value == null || typeof value !== "object") {
      continue;
    }
    const answer = value as Record<string, unknown>;
    if (answer.type === "noul" && typeof answer.noul === "number") {
      answers[name] = { type: "noul", noul: answer.noul };
    } else if (answer.type === "choice" && typeof answer.choice === "string") {
      answers[name] = {
        type: "choice",
        choice: answer.choice,
        confidence: typeof answer.confidence === "number" ? answer.confidence : undefined,
        probabilities: (answer.probabilities as Record<string, number> | undefined) ?? undefined,
      };
    } else if (answer.type === "score" && typeof answer.score === "number") {
      answers[name] = {
        type: "score",
        score: answer.score,
        confidence: typeof answer.confidence === "number" ? answer.confidence : undefined,
      };
    }
  }
  return answers;
}

export function createJevClient({ apiKey, model, fetchImpl }: JevClientOptions): JevClient {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const chosenModel = model ?? DEFAULT_JEV_MODEL;

  return {
    async ask(state, questions, options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const onAbort = (): void => controller.abort();
      options?.signal?.addEventListener("abort", onAbort);
      const started = performance.now();

      try {
        let response: Response;
        try {
          response = await doFetch(JEV_ENDPOINT, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "X-Title": "Dechoverse",
            },
            body: JSON.stringify({
              model: chosenModel,
              state,
              questions,
              ...(options?.user != null ? { user: options.user } : {}),
            }),
            signal: controller.signal,
          });
        } catch (error) {
          const aborted = controller.signal.aborted;
          throw new JevError(
            aborted
              ? `Jev did not answer within ${TIMEOUT_MS} ms`
              : `Jev unreachable: ${error instanceof Error ? error.message : String(error)}` +
                " (check the CSP allows openrouter.ai and that CORS is permitted)",
            null,
            null,
          );
        }

        if (!response.ok) {
          let detail = "";
          try {
            const body = (await response.json()) as { error?: { message?: string } };
            detail = body.error?.message ?? "";
          } catch {
            // No JSON body; the status says enough.
          }
          throw new JevError(
            `Jev ${response.status}${detail !== "" ? `: ${detail}` : ""}`,
            response.status,
            retryAfter(response),
          );
        }

        const body = (await response.json()) as {
          id?: string;
          model?: string;
          answers?: unknown;
          usage?: { input_tokens?: number; cost?: number };
        };
        return {
          id: body.id ?? null,
          model: body.model ?? null,
          answers: readAnswers(body.answers),
          inputTokens: body.usage?.input_tokens ?? 0,
          cost: body.usage?.cost ?? 0,
          latencyMs: performance.now() - started,
        };
      } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** A noul answer's probability, or null when it was not answered. */
export function noul(answers: Record<string, JevAnswer>, name: string): number | null {
  const answer = answers[name];
  return answer?.type === "noul" ? answer.noul : null;
}

/** A choice answer, or null. */
export function choice(
  answers: Record<string, JevAnswer>,
  name: string,
): { choice: string; confidence: number | null } | null {
  const answer = answers[name];
  return answer?.type === "choice"
    ? { choice: answer.choice, confidence: answer.confidence ?? null }
    : null;
}

/** A score answer, or null. */
export function score(answers: Record<string, JevAnswer>, name: string): number | null {
  const answer = answers[name];
  return answer?.type === "score" ? answer.score : null;
}
