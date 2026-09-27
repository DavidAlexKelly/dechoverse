import { describe, expect, test } from "vitest";
import { JEV_ENDPOINT, JevError, choice, createJevClient, noul, score } from "@/agents/brain/jev";
import { questionsFor, readReflexes } from "@/agents/brain/questions";

function fakeFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("createJevClient", () => {
  test("posts state and questions to OpenRouter's decisions endpoint", async () => {
    const { fetchImpl, calls } = fakeFetch(200, {
      id: "gen-dec-1",
      model: "typesafe/jev-1.13-20260917",
      answers: {
        addressed_to_me: { type: "noul", noul: 0.94 },
        next_state: { type: "choice", choice: "SOCIAL", confidence: 0.88 },
        urgency: { type: "score", score: 3.6 },
      },
      usage: { input_tokens: 400, output_tokens: 60, cost: 0.00002 },
    });
    const client = createJevClient({ apiKey: "sk-or-test", fetchImpl });
    const result = await client.ask({ self: {} }, questionsFor({
      mode: "EXPLORE",
      hasPending: true,
      pendingFromAgent: false,
      hasPartner: false,
      building: false,
    }), { user: "agent:echo:1" });

    expect(calls[0].url).toBe(JEV_ENDPOINT);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");
    const sent = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(sent.model).toBe("typesafe/jev-1.13");
    expect(sent.user).toBe("agent:echo:1");
    expect(Object.keys(sent.questions as object)).toEqual(
      expect.arrayContaining(["next_state", "urgency", "addressed_to_me"]),
    );

    expect(noul(result.answers, "addressed_to_me")).toBe(0.94);
    expect(choice(result.answers, "next_state")).toEqual({ choice: "SOCIAL", confidence: 0.88 });
    expect(score(result.answers, "urgency")).toBe(3.6);
    expect(result.cost).toBe(0.00002);

    const reflexes = readReflexes(result.answers);
    expect(reflexes.nextState?.choice).toBe("SOCIAL");
    expect(reflexes.addressedToMe).toBe(0.94);
    expect(reflexes.conversationOver).toBeNull();
  });

  test("out of credits is reported as such", async () => {
    const { fetchImpl } = fakeFetch(402, { error: { message: "Insufficient credits" } });
    const client = createJevClient({ apiKey: "k", fetchImpl });
    const failure = await client.ask({}, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JevError);
    expect((failure as JevError).outOfCredits).toBe(true);
    expect((failure as JevError).message).toContain("Insufficient credits");
  });

  test("Retry-After is carried on a rate limit", async () => {
    const { fetchImpl } = fakeFetch(429, {}, { "retry-after": "2" });
    const client = createJevClient({ apiKey: "k", fetchImpl });
    const failure = (await client.ask({}, {}).catch((error: unknown) => error)) as JevError;
    expect(failure.status).toBe(429);
    expect(failure.retryAfterMs).toBe(2000);
  });

  test("answers of an unknown shape are ignored rather than trusted", async () => {
    const { fetchImpl } = fakeFetch(200, {
      answers: { weird: { type: "noul", noul: "yes" }, next_state: { type: "choice", choice: "DANCE" } },
    });
    const client = createJevClient({ apiKey: "k", fetchImpl });
    const result = await client.ask({}, {});
    expect(result.answers.weird).toBeUndefined();
    expect(readReflexes(result.answers).nextState).toBeNull();
  });
});

describe("questionsFor", () => {
  test("only asks what matters right now", () => {
    const idle = questionsFor({
      mode: "IDLE",
      hasPending: false,
      pendingFromAgent: false,
      hasPartner: false,
      building: false,
    });
    expect(Object.keys(idle).sort()).toEqual(["next_state", "urgency"]);

    const busy = questionsFor({
      mode: "SOCIAL",
      hasPending: true,
      pendingFromAgent: true,
      hasPartner: true,
      building: true,
    });
    expect(Object.keys(busy)).toEqual(
      expect.arrayContaining([
        "addressed_to_me",
        "worth_replying",
        "conversation_over",
        "stuck",
      ]),
    );
  });
});
