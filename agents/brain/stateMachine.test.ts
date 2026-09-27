import { describe, expect, test } from "vitest";
import {
  type Intent,
  type MindState,
  NO_REFLEXES,
  type PendingMessage,
  type Reflexes,
  type Situation,
  decide,
  initialMind,
} from "@/agents/brain/stateMachine";

const DANA = { sessionId: "human-1", userId: "Dana" };

function situation(overrides: Partial<Situation> = {}): Situation {
  return {
    now: 10000,
    reflexes: null,
    pending: null,
    partnerDistance: null,
    nearbyHuman: null,
    hasPlan: false,
    planComplete: false,
    hasWaypoint: false,
    agentTurns: 0,
    ...overrides,
  };
}

function reflexes(overrides: Partial<Reflexes>): Reflexes {
  return { ...NO_REFLEXES, ...overrides };
}

function message(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    key: "m1",
    sessionId: DANA.sessionId,
    userId: DANA.userId,
    isAgent: false,
    mentionsName: false,
    receivedAt: 9900,
    ...overrides,
  };
}

function mind(overrides: Partial<MindState> = {}): MindState {
  return { ...initialMind(0), ...overrides };
}

const types = (intents: Intent[]): string[] => intents.map((intent) => intent.type);

describe("being spoken to", () => {
  test("a message Jev says is for me: react, face and reply", () => {
    const { state, intents } = decide(
      mind({ mode: "EXPLORE" }),
      situation({ pending: message(), reflexes: reflexes({ addressedToMe: 0.91 }) }),
    );
    expect(state.mode).toBe("REACTING");
    expect(state.partner).toEqual(DANA);
    expect(intents).toContainEqual({ type: "reply", messageKey: "m1" });
    expect(intents).toContainEqual({ type: "face", sessionId: DANA.sessionId });
  });

  test("saying my name is enough without Jev", () => {
    const { intents } = decide(
      mind(),
      situation({ pending: message({ mentionsName: true }), reflexes: reflexes({}) }),
    );
    expect(types(intents)).toContain("reply");
  });

  test("with no answer from Jev yet, wait rather than guess", () => {
    const { intents } = decide(mind(), situation({ pending: message(), reflexes: null }));
    expect(types(intents)).not.toContain("reply");
    expect(types(intents)).not.toContain("ignore");
  });

  test("unsure whether it was for me: escalate to the LLM", () => {
    const { intents } = decide(
      mind(),
      situation({ pending: message(), reflexes: reflexes({ addressedToMe: 0.5 }) }),
    );
    expect(intents).toContainEqual({ type: "escalate", topic: "answer", messageKey: "m1" });
  });

  test("clearly not for me: ignore it", () => {
    const { intents } = decide(
      mind(),
      situation({ pending: message(), reflexes: reflexes({ addressedToMe: 0.1 }) }),
    );
    expect(intents).toContainEqual({ type: "ignore", messageKey: "m1" });
  });

  test("my conversation partner only has to be plausibly talking to me", () => {
    const { intents } = decide(
      mind({ mode: "SOCIAL", partner: DANA, lastHeardAt: 9000 }),
      situation({
        pending: message(),
        reflexes: reflexes({ addressedToMe: 0.5 }),
        partnerDistance: 3,
      }),
    );
    expect(types(intents)).toContain("reply");
  });

  test("REACTING lasts one beat, then becomes SOCIAL", () => {
    const { state } = decide(
      mind({ mode: "REACTING", partner: DANA, since: 9500 }),
      situation({ partnerDistance: 3 }),
    );
    expect(state.mode).toBe("SOCIAL");
  });
});

describe("talking while busy", () => {
  test("a builder answers without putting the build down", () => {
    const { state, intents } = decide(
      mind({ mode: "BUILD", since: 0 }),
      situation({ pending: message(), reflexes: reflexes({ addressedToMe: 0.95 }), hasPlan: true }),
    );
    expect(state.mode).toBe("BUILD");
    expect(types(intents)).toEqual(expect.arrayContaining(["reply", "build"]));
  });

  test("a follower keeps following through a long silence", () => {
    const { state } = decide(
      mind({ mode: "SOCIAL", partner: DANA, lastHeardAt: 0, since: 0, following: true }),
      situation({ now: 120000, partnerDistance: 8, reflexes: reflexes({ conversationOver: 0.95 }) }),
    );
    expect(state.mode).toBe("SOCIAL");
  });

  test("but not once the partner is out of earshot", () => {
    const { state } = decide(
      mind({ mode: "SOCIAL", partner: DANA, lastHeardAt: 0, since: 0, following: true }),
      situation({ partnerDistance: 60 }),
    );
    expect(state.mode).not.toBe("SOCIAL");
    expect(state.following).toBe(false);
  });
});

describe("agents talking to agents", () => {
  test("an AI that names me gets an answer, whatever Jev thinks of it", () => {
    const { intents } = decide(
      mind(),
      situation({
        pending: message({ sessionId: "agent:pixel:1", userId: "Pixel 🤖", isAgent: true, mentionsName: true }),
        reflexes: reflexes({ worthReplying: 0.1 }),
      }),
    );
    expect(types(intents)).toContain("reply");
  });

  test("so does my AI conversation partner, even with Jev off", () => {
    const pixel = { sessionId: "agent:pixel:1", userId: "Pixel 🤖" };
    const { intents } = decide(
      mind({ mode: "SOCIAL", partner: pixel, lastHeardAt: 9000, since: 9000 }),
      situation({ pending: message({ ...pixel, isAgent: true }), reflexes: null, partnerDistance: 4 }),
    );
    expect(types(intents)).toContain("reply");
  });

  const fromAgent = message({ sessionId: "agent:pixel:1", userId: "Pixel 🤖", isAgent: true });

  test("only when Jev thinks it is worth it", () => {
    const { intents } = decide(
      mind(),
      situation({ pending: fromAgent, reflexes: reflexes({ addressedToMe: 0.95, worthReplying: 0.5 }) }),
    );
    expect(types(intents)).toEqual(expect.arrayContaining(["ignore"]));
    expect(types(intents)).not.toContain("reply");
  });

  test("and never past the per-minute turn limit", () => {
    const { intents } = decide(
      mind(),
      situation({
        pending: fromAgent,
        reflexes: reflexes({ addressedToMe: 0.95, worthReplying: 0.95 }),
        agentTurns: 12,
      }),
    );
    expect(types(intents)).not.toContain("reply");
  });

  test("but a worthwhile message within the limit is answered", () => {
    const { intents } = decide(
      mind(),
      situation({
        pending: fromAgent,
        reflexes: reflexes({ addressedToMe: 0.95, worthReplying: 0.95 }),
        agentTurns: 1,
      }),
    );
    expect(types(intents)).toContain("reply");
  });
});

describe("conversations ending", () => {
  test("the partner walks out of earshot", () => {
    const { state } = decide(
      mind({ mode: "SOCIAL", partner: DANA, lastHeardAt: 9000, since: 0 }),
      situation({ partnerDistance: 40 }),
    );
    expect(state.mode).toBe("EXPLORE");
    expect(state.partner).toBeNull();
  });

  test("Jev says it is over and it has gone quiet", () => {
    const { state } = decide(
      mind({ mode: "SOCIAL", partner: DANA, lastHeardAt: 0, since: 0 }),
      situation({ partnerDistance: 3, reflexes: reflexes({ conversationOver: 0.9 }) }),
    );
    expect(state.mode).not.toBe("SOCIAL");
  });

  test("after a conversation, an unfinished plan is picked back up", () => {
    const { state } = decide(
      mind({ mode: "SOCIAL", partner: DANA, lastHeardAt: 0, since: 0 }),
      situation({ partnerDistance: 50, hasPlan: true }),
    );
    expect(state.mode).toBe("BUILD");
  });

  test("walk over when the partner is further than talking distance", () => {
    const { intents } = decide(
      mind({ mode: "SOCIAL", partner: DANA, lastHeardAt: 9000, since: 9000 }),
      situation({ partnerDistance: 12 }),
    );
    expect(intents).toContainEqual({ type: "approach", sessionId: DANA.sessionId });
  });
});

describe("switching modes on Jev's suggestion", () => {
  test("hysteresis: not within three seconds of the last change", () => {
    const { state } = decide(
      mind({ mode: "EXPLORE", since: 9000 }),
      situation({ reflexes: reflexes({ nextState: { choice: "IDLE", confidence: 0.9 } }) }),
    );
    expect(state.mode).toBe("EXPLORE");
  });

  test("unless it is urgent", () => {
    const { state } = decide(
      mind({ mode: "EXPLORE", since: 9000 }),
      situation({ reflexes: reflexes({ nextState: { choice: "IDLE", confidence: 0.9 }, urgency: 3.5 }) }),
    );
    expect(state.mode).toBe("IDLE");
  });

  test("an unsure suggestion is escalated, not followed", () => {
    const { state, intents } = decide(
      mind({ mode: "EXPLORE", since: 0 }),
      situation({ reflexes: reflexes({ nextState: { choice: "IDLE", confidence: 0.4 } }) }),
    );
    expect(state.mode).toBe("EXPLORE");
    expect(intents).toContainEqual({ type: "escalate", topic: "mode" });
  });

  test("BUILD without a plan asks for a goal and stays put", () => {
    const { state, intents } = decide(
      mind({ mode: "IDLE", since: 0 }),
      situation({ reflexes: reflexes({ nextState: { choice: "BUILD", confidence: 0.9 } }) }),
    );
    expect(state.mode).toBe("IDLE");
    expect(types(intents)).toContain("chooseGoal");
  });

  test("SOCIAL walks over to the nearest human and greets them", () => {
    const { state, intents } = decide(
      mind({ mode: "EXPLORE", since: 0 }),
      situation({
        reflexes: reflexes({ nextState: { choice: "SOCIAL", confidence: 0.9 } }),
        nearbyHuman: { ...DANA, distance: 8, greetedRecently: false },
      }),
    );
    expect(state.mode).toBe("SOCIAL");
    expect(types(intents)).toEqual(expect.arrayContaining(["greet", "approach"]));
  });

  test("SOCIAL with nobody near is not a mode worth entering", () => {
    const { state } = decide(
      mind({ mode: "EXPLORE", since: 0 }),
      situation({ reflexes: reflexes({ nextState: { choice: "SOCIAL", confidence: 0.9 } }) }),
    );
    expect(state.mode).toBe("EXPLORE");
  });
});

describe("building and wandering", () => {
  test("BUILD keeps building while the plan lasts", () => {
    const { state, intents } = decide(
      mind({ mode: "BUILD", since: 0 }),
      situation({ hasPlan: true }),
    );
    expect(state.mode).toBe("BUILD");
    expect(types(intents)).toContain("build");
  });

  test("a passing suggestion to explore does not abandon an unfinished plan", () => {
    const { state } = decide(
      mind({ mode: "BUILD", since: 0 }),
      situation({ hasPlan: true, reflexes: reflexes({ nextState: { choice: "EXPLORE", confidence: 0.95 } }) }),
    );
    expect(state.mode).toBe("BUILD");
  });

  test("an idle or exploring agent goes back to an unfinished plan", () => {
    const { state, intents } = decide(
      mind({ mode: "EXPLORE", since: 0 }),
      situation({ hasPlan: true, reflexes: reflexes({ nextState: { choice: "EXPLORE", confidence: 0.95 } }) }),
    );
    expect(state.mode).toBe("BUILD");
    expect(types(intents)).toContain("build");
  });

  test("a finished plan returns to IDLE", () => {
    const { state } = decide(
      mind({ mode: "BUILD", since: 0 }),
      situation({ hasPlan: true, planComplete: true }),
    );
    expect(state.mode).toBe("IDLE");
  });

  test("stuck: abandon the plan and go exploring", () => {
    const { state, intents } = decide(
      mind({ mode: "BUILD", since: 0 }),
      situation({ hasPlan: true, reflexes: reflexes({ stuck: 0.9 }) }),
    );
    expect(state.mode).toBe("EXPLORE");
    expect(types(intents)).toContain("abandonPlan");
  });

  test("EXPLORE with nowhere to go picks somewhere", () => {
    const { intents } = decide(mind({ mode: "EXPLORE", since: 0 }), situation());
    expect(types(intents)).toContain("wander");
  });

  test("without Jev, boredom eventually gets an idle agent moving", () => {
    const { state } = decide(mind({ mode: "IDLE", since: 0 }), situation({ now: 30000 }));
    expect(state.mode).toBe("EXPLORE");
    // …including when the heuristics stand in for Jev and suggest no mode.
    const heuristic = decide(
      mind({ mode: "IDLE", since: 0 }),
      situation({ now: 30000, reflexes: reflexes({ addressedToMe: null }) }),
    );
    expect(heuristic.state.mode).toBe("EXPLORE");
  });
});
