/**
 * The agent's behavioural state machine, as a pure reducer.
 *
 * (state, situation) → { state, intents }. No I/O, no clock, no randomness:
 * the host gathers the situation (what Jev answered, what was heard, where
 * people are) and carries out the intents (walk, speak, ask the LLM, build).
 * That split is what makes every transition in the plan's table testable
 * without a stream, a model or a browser — see stateMachine.test.ts.
 *
 *                  IDLE
 *          ┌────────┼────────┐
 *       EXPLORE   SOCIAL   BUILD
 *          └────────┼────────┘
 *               REACTING   (one tick, then SOCIAL)
 */

export type Mode = "IDLE" | "EXPLORE" | "SOCIAL" | "BUILD" | "REACTING";

export const PRIMARY_MODES: Mode[] = ["IDLE", "EXPLORE", "SOCIAL", "BUILD"];

/** Jev's answers, already read out of the response. Null = not asked or not answered. */
export interface Reflexes {
  /** The pending message is addressed to this agent. */
  addressedToMe: number | null;
  nextState: { choice: Mode; confidence: number | null } | null;
  /** 0 ignorable … 4 must respond now. */
  urgency: number | null;
  conversationOver: number | null;
  /** Another agent's message deserves a reply at all. */
  worthReplying: number | null;
  stuck: number | null;
}

export const NO_REFLEXES: Reflexes = {
  addressedToMe: null,
  nextState: null,
  urgency: null,
  conversationOver: null,
  worthReplying: null,
  stuck: null,
};

/** The newest message within earshot that has not been dealt with. */
export interface PendingMessage {
  /** Short key the host uses to find it again (m1, m2, …). */
  key: string;
  sessionId: string;
  userId: string;
  isAgent: boolean;
  /** Says this agent's name, which settles "is it for me" without asking. */
  mentionsName: boolean;
  receivedAt: number;
}

export interface Someone {
  sessionId: string;
  userId: string;
}

export interface MindState {
  mode: Mode;
  /** When the current mode was entered. */
  since: number;
  /** Who a conversation is with. */
  partner: Someone | null;
  /** When the partner last said something. */
  lastHeardAt: number;
  /** When a new goal was last asked for, so it is not asked every tick. */
  goalRequestedAt: number;
  /**
   * Asked to come along: keep with the partner however quiet it gets, until
   * told to stay or the partner walks out of earshot.
   */
  following: boolean;
}

export interface Situation {
  now: number;
  /** Fresh answers this tick, or null when Jev has not answered since the last. */
  reflexes: Reflexes | null;
  pending: PendingMessage | null;
  /** The partner is still in the room, and how far away. */
  partnerDistance: number | null;
  /** Nearest human within greeting range, for starting a conversation unprompted. */
  nearbyHuman: (Someone & { distance: number; greetedRecently: boolean }) | null;
  hasPlan: boolean;
  planComplete: boolean;
  hasWaypoint: boolean;
  /** Agent-to-agent turns in this thread in the last minute. */
  agentTurns: number;
}

export type Intent =
  | { type: "reply"; messageKey: string }
  | { type: "ignore"; messageKey: string }
  | { type: "greet"; sessionId: string }
  | { type: "approach"; sessionId: string }
  | { type: "face"; sessionId: string }
  | { type: "escalate"; topic: "answer"; messageKey: string }
  | { type: "escalate"; topic: "mode" }
  | { type: "chooseGoal" }
  | { type: "wander" }
  | { type: "build" }
  | { type: "abandonPlan" }
  | { type: "stand" };

/** A mode must last this long before Jev may change it, unless it is urgent. */
export const MIN_MODE_MS = 3000;
/** Urgency at or above this overrides hysteresis. */
export const URGENT = 3;
/** Addressed with at least this probability: answer. */
export const ADDRESSED = 0.7;
/** Between this and ADDRESSED: unsure, so ask the LLM. Below: ignore. */
export const MAYBE_ADDRESSED = 0.4;
/** Jev's mode choice below this confidence is escalated. */
export const CONFIDENT = 0.55;
/**
 * An agent joins in when another agent is *not* talking to it only if Jev is
 * this sure it is worth it. Spoken to by name, or by its conversation
 * partner, it simply answers.
 */
export const WORTH_REPLYING = 0.8;
/** At most this many agent-to-agent turns a minute. */
export const MAX_AGENT_TURNS = 12;
/** Conversation partners further than this have walked off. Matches HEARING_RADIUS. */
export const EARSHOT = 32;
/** Walk towards the partner when further than this. */
export const TALKING_DISTANCE = 5;
/** Silence this long ends a conversation whatever Jev says. */
export const CONVERSATION_TIMEOUT_MS = 45000;
/** After this long idle without Jev, wander anyway. */
export const BORED_AFTER_MS = 20000;
/** Do not ask for a new goal more often than this. */
export const GOAL_RETRY_MS = 60000;
/** Greet someone unprompted only this close. */
export const GREETING_DISTANCE = 12;

export function initialMind(now: number): MindState {
  return {
    mode: "IDLE",
    since: now,
    partner: null,
    lastHeardAt: 0,
    goalRequestedAt: -Infinity,
    following: false,
  };
}

function enter(state: MindState, mode: Mode, now: number): MindState {
  return state.mode === mode ? state : { ...state, mode, since: now };
}

/** Where to go when a conversation or a build ends. */
function afterwards(situation: Situation, reflexes: Reflexes | null): Mode {
  const wanted = reflexes?.nextState?.choice;
  if (wanted === "BUILD" && situation.hasPlan && !situation.planComplete) {
    return "BUILD";
  }
  if (wanted === "IDLE") {
    return "IDLE";
  }
  return situation.hasPlan && !situation.planComplete ? "BUILD" : "EXPLORE";
}

export function decide(
  previous: MindState,
  situation: Situation,
): { state: MindState; intents: Intent[] } {
  const { now } = situation;
  const reflexes = situation.reflexes;
  const intents: Intent[] = [];
  let state = previous;

  const urgent = (reflexes?.urgency ?? 0) >= URGENT;
  const settled = now - state.since >= MIN_MODE_MS || urgent;

  // ── 1. Something was said ──────────────────────────────────────────────
  const pending = situation.pending;
  if (pending != null) {
    const fromPartner = state.partner?.sessionId === pending.sessionId;
    const addressed = pending.mentionsName
      ? Math.max(reflexes?.addressedToMe ?? 0, 0.9)
      : reflexes?.addressedToMe ?? null;

    // Another AI talking to me — by name, or as my conversation partner — is
    // a conversation, and gets an answer. Ambient AI chatter only draws one
    // in when Jev says it is worth it. Either way a thread is capped, so two
    // agents cannot talk forever; a human is never subject to the cap.
    const agentEngaged = pending.isAgent && (pending.mentionsName || fromPartner);
    const agentDeclined =
      pending.isAgent &&
      (situation.agentTurns >= MAX_AGENT_TURNS ||
        (!agentEngaged && (reflexes?.worthReplying ?? 0) < WORTH_REPLYING));

    if (addressed == null && !agentEngaged) {
      // Nothing to go on yet: wait for Jev's next answer rather than guess.
    } else if (agentDeclined) {
      intents.push({ type: "ignore", messageKey: pending.key });
    } else if (agentEngaged || (addressed ?? 0) >= ADDRESSED || (fromPartner && (addressed ?? 0) >= MAYBE_ADDRESSED)) {
      state = {
        ...state,
        partner: { sessionId: pending.sessionId, userId: pending.userId },
        lastHeardAt: now,
      };
      // Talking does not stop a build: answer over your shoulder and carry on.
      if (state.mode !== "SOCIAL" && state.mode !== "BUILD") {
        state = enter(state, "REACTING", now);
      }
      intents.push({ type: "face", sessionId: pending.sessionId });
      intents.push({ type: "reply", messageKey: pending.key });
    } else if ((addressed ?? 0) >= MAYBE_ADDRESSED && !pending.isAgent) {
      intents.push({ type: "escalate", topic: "answer", messageKey: pending.key });
    } else {
      intents.push({ type: "ignore", messageKey: pending.key });
    }
  }

  // ── 2. The mode itself ──────────────────────────────────────────────────
  switch (state.mode) {
    case "REACTING": {
      // Reacting is a beat, not a place to stay: one tick, then talk.
      if (intents.some((intent) => intent.type === "reply")) {
        break;
      }
      state = enter(state, state.partner != null ? "SOCIAL" : "IDLE", now);
      break;
    }

    case "SOCIAL": {
      const partner = state.partner;
      const gone =
        partner == null ||
        situation.partnerDistance == null ||
        situation.partnerDistance > EARSHOT;
      const quiet = now - state.lastHeardAt;
      const over =
        !state.following && (reflexes?.conversationOver ?? 0) > 0.7 && quiet > 8000 && settled;
      const timedOut = !state.following && quiet > CONVERSATION_TIMEOUT_MS;
      if (gone || over || timedOut) {
        state = {
          ...enter(state, afterwards(situation, reflexes), now),
          partner: null,
          following: false,
        };
        break;
      }
      if (situation.partnerDistance != null && situation.partnerDistance > TALKING_DISTANCE) {
        intents.push({ type: "approach", sessionId: partner.sessionId });
      } else {
        intents.push({ type: "face", sessionId: partner.sessionId });
      }
      // Building on request goes through the reply's "build" action; there is
      // no separate "wants to build with me" reflex any more.
      break;
    }

    case "BUILD": {
      if (!situation.hasPlan || situation.planComplete) {
        state = enter(state, "IDLE", now);
        break;
      }
      if ((reflexes?.stuck ?? 0) > 0.75) {
        intents.push({ type: "abandonPlan" });
        state = enter(state, "EXPLORE", now);
        break;
      }
      // An unfinished plan is not dropped on a passing suggestion. People are
      // answered while building (above), and a build ends when it is done,
      // stuck, or someone asks for it to stop.
      intents.push({ type: "build" });
      break;
    }

    case "IDLE":
    case "EXPLORE": {
      if (situation.hasPlan && !situation.planComplete && settled) {
        // Back to the unfinished build, unless someone wants to talk first.
        state =
          reflexes?.nextState?.choice === "SOCIAL"
            ? switchByReflex(state, situation, settled, intents)
            : enter(state, "BUILD", now);
        if (state.mode === "BUILD") {
          intents.push({ type: "build" });
        }
        break;
      }
      state = switchByReflex(state, situation, settled, intents);
      if (state.mode === "IDLE" && reflexes?.nextState == null && now - state.since > BORED_AFTER_MS) {
        // Jev is quiet or off: nobody should stand still forever.
        state = enter(state, "EXPLORE", now);
      }
      if (state.mode === "EXPLORE" && !situation.hasWaypoint) {
        intents.push({ type: "wander" });
      }
      if (state.mode === "IDLE") {
        intents.push({ type: "stand" });
      }
      if (state.mode === "BUILD") {
        intents.push({ type: "build" });
      }
      break;
    }
  }

  return { state, intents };
}

/**
 * Jev's suggested next mode, applied with hysteresis — and escalated to the
 * LLM when Jev itself is unsure.
 */
function switchByReflex(
  state: MindState,
  situation: Situation,
  settled: boolean,
  intents: Intent[],
): MindState {
  const reflexes = situation.reflexes;
  const suggestion = reflexes?.nextState;
  if (suggestion == null || !settled || suggestion.choice === state.mode) {
    return state;
  }
  if (suggestion.confidence != null && suggestion.confidence < CONFIDENT) {
    intents.push({ type: "escalate", topic: "mode" });
    return state;
  }
  return applyMode(state, suggestion.choice, situation, intents);
}

/**
 * Moves to a mode chosen by Jev or by the LLM, doing what that mode needs to
 * start: SOCIAL needs someone to talk to, BUILD needs a plan.
 */
export function applyMode(
  state: MindState,
  mode: Mode,
  situation: Situation,
  intents: Intent[],
): MindState {
  const { now } = situation;
  switch (mode) {
    case "SOCIAL": {
      const human = situation.nearbyHuman;
      if (human == null || human.distance > GREETING_DISTANCE) {
        return state;
      }
      if (!human.greetedRecently) {
        intents.push({ type: "greet", sessionId: human.sessionId });
      }
      intents.push({ type: "approach", sessionId: human.sessionId });
      return {
        ...enter(state, "SOCIAL", now),
        partner: { sessionId: human.sessionId, userId: human.userId },
        lastHeardAt: now,
      };
    }
    case "BUILD": {
      if (situation.hasPlan && !situation.planComplete) {
        return enter(state, "BUILD", now);
      }
      if (now - state.goalRequestedAt > GOAL_RETRY_MS) {
        intents.push({ type: "chooseGoal" });
        return { ...state, goalRequestedAt: now };
      }
      return state;
    }
    case "IDLE":
    case "EXPLORE":
      return enter(state, mode, now);
    case "REACTING":
      return state;
  }
}
