import { type JevAnswer, type JevQuestions, choice, noul, score } from "@/agents/brain/jev";
import { type Mode, PRIMARY_MODES, type Reflexes } from "@/agents/brain/stateMachine";

/**
 * What Jev is asked, and how its answers become Reflexes.
 *
 * Only the questions that matter right now are sent: every question is input
 * tokens, and a question about a conversation nobody is having invites a
 * confident answer about nothing. Question names are part of the contract
 * with readReflexes below, so they live in one place.
 */

export interface QuestionContext {
  mode: Mode;
  hasPending: boolean;
  pendingFromAgent: boolean;
  hasPartner: boolean;
  building: boolean;
}

const NEXT_STATE_CRITERIA: Record<Mode, string> = {
  IDLE: "Nothing nearby is worth attention; rest and watch for a while.",
  EXPLORE: "No one to talk to and nothing to build right now; wander to somewhere new.",
  SOCIAL:
    "A person within earshot is engaging with the agent, or is close by and likely to enjoy a chat.",
  BUILD: "The agent has, or should start, something to build, and nothing social is more pressing.",
  REACTING: "",
};

export function questionsFor(context: QuestionContext): JevQuestions {
  const questions: JevQuestions = {
    next_state: {
      type: "choice",
      instructions:
        "Which behaviour suits the agent best right now, given who is near, what was said, and what it is doing?",
      criteria: Object.fromEntries(PRIMARY_MODES.map((mode) => [mode, NEXT_STATE_CRITERIA[mode]])),
    },
    urgency: {
      type: "score",
      instructions: "How urgently should the agent interrupt what it is doing?",
      criteria: [
        "ignorable",
        "mildly interesting",
        "notable",
        "someone is waiting on the agent",
        "must respond right now",
      ],
    },
  };

  if (context.hasPending) {
    questions.addressed_to_me = {
      type: "noul",
      instructions:
        "The pending message is directed at this agent: it uses the agent's name, answers something the agent said, asks 'you' while the speaker is near and facing it, or is a greeting to whoever is close.",
      criteria: {
        true: "Meant for this agent.",
        false: "Meant for someone else, or ambient chatter.",
      },
    };
  }

  if (context.hasPending && context.pendingFromAgent) {
    questions.worth_replying = {
      type: "noul",
      instructions:
        "Replying to this other AI's message would add something new, rather than continue small talk for its own sake.",
    };
  }

  if (context.hasPartner) {
    questions.conversation_over = {
      type: "noul",
      instructions:
        "The conversation between the agent and its partner has wound down: goodbyes, a long silence, or the partner has moved on to something else.",
    };
  }

  if (context.building) {
    questions.stuck = {
      type: "noul",
      instructions:
        "The agent's build is not progressing: it has not placed a cube for a while, keeps failing to reach the site, or the site is now occupied.",
    };
  }

  return questions;
}

function isMode(value: string): value is Mode {
  return (PRIMARY_MODES as string[]).includes(value);
}

export function readReflexes(answers: Record<string, JevAnswer>): Reflexes {
  const next = choice(answers, "next_state");
  return {
    addressedToMe: noul(answers, "addressed_to_me"),
    nextState:
      next != null && isMode(next.choice)
        ? { choice: next.choice, confidence: next.confidence }
        : null,
    urgency: score(answers, "urgency"),
    conversationOver: noul(answers, "conversation_over"),
    worthReplying: noul(answers, "worth_replying"),
    stuck: noul(answers, "stuck"),
  };
}

/** Asked of every line before it is spoken. */
export const MODERATION_QUESTIONS: JevQuestions = {
  is_inappropriate: {
    type: "noul",
    instructions:
      "This line, about to be said out loud in a shared world with colleagues, is hateful, sexual, harassing, cruel, or reveals private information.",
  },
};

/** Drop a line whose inappropriateness is above this. */
export const MODERATION_THRESHOLD = 0.3;

/** Unsure whether to answer: ask the model to choose. */
export const ANSWER_OPTIONS = [
  { key: "answer", label: "It was meant for me, or answering would be welcome: reply." },
  { key: "ignore", label: "It was not for me: stay out of it." },
];
