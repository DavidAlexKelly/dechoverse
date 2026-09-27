/**
 * What each agent remembers about the people it has met.
 *
 * Kept in this browser's localStorage, per agent, until memories move into
 * the Ontology (AGENT PLAYERS PLAN §7, DechoAgentMemory). The interface is
 * what the host uses either way — remember, recall — so that move changes
 * this file and nothing else.
 *
 * Every access is guarded: storage can be full, disabled or blocked, and a
 * resident that forgets is fine; one that crashes is not.
 */

export interface Memory {
  aboutUser: string;
  text: string;
  at: number;
}

const KEY_PREFIX = "dechoverse-agent-memory:";
/** Per agent. Oldest are forgotten first. */
const MAX_MEMORIES = 200;

function load(agentId: string): Memory[] {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + agentId);
    if (raw == null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is Memory =>
            entry != null &&
            typeof entry === "object" &&
            typeof (entry as Memory).aboutUser === "string" &&
            typeof (entry as Memory).text === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function save(agentId: string, memories: Memory[]): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + agentId, JSON.stringify(memories));
  } catch {
    // Forgetting is allowed.
  }
}

export function remember(agentId: string, aboutUser: string, text: string): void {
  const memories = load(agentId);
  // The same fact twice is not two facts.
  if (memories.some((memory) => memory.aboutUser === aboutUser && memory.text === text)) {
    return;
  }
  memories.push({ aboutUser, text, at: Date.now() });
  save(agentId, memories.slice(-MAX_MEMORIES));
}

/** The newest few things remembered about someone. */
export function recall(agentId: string, aboutUser: string, limit = 5): string[] {
  return load(agentId)
    .filter((memory) => memory.aboutUser === aboutUser)
    .slice(-limit)
    .map((memory) => memory.text);
}

export function memoryCount(agentId: string): number {
  return load(agentId).length;
}

export function forgetAll(agentId: string): void {
  try {
    window.localStorage.removeItem(KEY_PREFIX + agentId);
  } catch {
    // Nothing to do.
  }
}
