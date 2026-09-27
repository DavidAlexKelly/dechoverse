/* eslint-disable no-console */
import type { JevAnswer, JevQuestions, JevResult } from "@/agents/brain/jev";
import type { Intent, Mode, Reflexes } from "@/agents/brain/stateMachine";

/**
 * Jev in the browser console: every request, answer, failure and the
 * decision taken from it, prefixed "[jev]" so it can be filtered.
 *
 * On by default. To silence it: localStorage.setItem("dechoverse-jev-log", "off")
 * in the console, and reload.
 */

const FLAG = "dechoverse-jev-log";

function enabled(): boolean {
  try {
    return window.localStorage.getItem(FLAG) !== "off";
  } catch {
    return true;
  }
}

function describeAnswer(answer: JevAnswer): string {
  switch (answer.type) {
    case "noul":
      return `yes ${Math.round(answer.noul * 100)}%`;
    case "choice":
      return `${answer.choice}${answer.confidence != null ? ` (${Math.round(answer.confidence * 100)}% sure)` : ""}`;
    case "score":
      return `${answer.score.toFixed(2)}${answer.confidence != null ? ` (${Math.round(answer.confidence * 100)}% sure)` : ""}`;
  }
}

/** Whether Jev is on, and if not, why — logged whenever that changes. */
export function logJevStatus(on: boolean, detail: string): void {
  if (!enabled()) {
    return;
  }
  if (on) {
    console.info(`[jev] ON — ${detail}`);
  } else {
    console.warn(`[jev] OFF — ${detail}`);
  }
}

/** One Jev round trip for one agent. */
export function logJevAnswer(
  agent: string,
  mode: Mode,
  state: unknown,
  questions: JevQuestions,
  result: JevResult,
  reflexes: Reflexes,
): void {
  if (!enabled()) {
    return;
  }
  const next = reflexes.nextState;
  const headline = [
    next != null ? `next ${next.choice}` : null,
    reflexes.addressedToMe != null ? `for me ${Math.round(reflexes.addressedToMe * 100)}%` : null,
    reflexes.urgency != null ? `urgency ${reflexes.urgency.toFixed(1)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  console.groupCollapsed(
    `[jev] ${agent} (${mode}) ${Math.round(result.latencyMs)} ms — ${headline || "no answers"}`,
  );
  const rows: Record<string, { asked: string; answer: string }> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = result.answers[name];
    rows[name] = {
      asked: question.type,
      answer: answer != null ? describeAnswer(answer) : "(not answered)",
    };
  }
  console.table(rows);
  console.log("state sent:", state);
  console.log("raw answers:", result.answers);
  console.log(
    `model ${result.model ?? "?"} · ${result.inputTokens} input tokens · $${result.cost.toFixed(6)} · id ${result.id ?? "?"}`,
  );
  console.groupEnd();
}

export function logJevFailure(agent: string, message: string, status: number | null): void {
  if (!enabled()) {
    return;
  }
  console.warn(
    `[jev] ${agent} request failed${status != null ? ` (HTTP ${status})` : ""}: ${message}` +
      (status == null
        ? " — no response at all usually means the Content Security Policy blocked openrouter.ai, CORS refused it, or the network is down"
        : ""),
  );
}

/** What the state machine did with the answers, when it did anything. */
export function logDecision(agent: string, before: Mode, after: Mode, intents: Intent[]): void {
  if (!enabled()) {
    return;
  }
  const notable = intents.filter(
    (intent) => intent.type !== "stand" && intent.type !== "build" && intent.type !== "face",
  );
  if (before === after && notable.length === 0) {
    return;
  }
  const described = notable.map((intent) => {
    switch (intent.type) {
      case "reply":
      case "ignore":
        return `${intent.type} ${intent.messageKey}`;
      case "escalate":
        return intent.topic === "answer" ? `ask LLM: answer ${intent.messageKey}?` : "ask LLM: which mode?";
      default:
        return intent.type;
    }
  });
  console.info(
    `[jev] ${agent} decided: ${before === after ? before : `${before} → ${after}`}` +
      (described.length > 0 ? ` · ${described.join(", ")}` : ""),
  );
}
