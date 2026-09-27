/**
 * How an AI player is told apart on the wire, without changing any schema.
 *
 * Every record an agent writes is an ordinary presence, chat, mark or
 * character record. Two conventions mark it as an agent's:
 *
 * - the userId (its display name) ends in AGENT_NAME_SUFFIX, so humans can
 *   see at a glance who is an AI — and so its personal room, whose key is
 *   derived from the userId, can never collide with a human's;
 * - the sessionId starts with AGENT_SESSION_PREFIX, so other agents can tell
 *   without parsing names. Human clients ignore sessionId formats entirely.
 */
export const AGENT_SESSION_PREFIX = "agent:";
export const AGENT_NAME_SUFFIX = " 🤖";

export function isAgentSession(sessionId: string): boolean {
  return sessionId.startsWith(AGENT_SESSION_PREFIX);
}

/** The userId an agent publishes under. */
export function agentUserId(name: string): string {
  return `${name}${AGENT_NAME_SUFFIX}`;
}

/** A fresh session per spawn, so a restarted agent is a new presence track. */
export function agentSessionId(agentId: string): string {
  return `${AGENT_SESSION_PREFIX}${agentId}:${crypto.randomUUID().slice(0, 8)}`;
}

/** The name without the suffix, for prompts. */
export function plainName(userId: string): string {
  return userId.endsWith(AGENT_NAME_SUFFIX)
    ? userId.slice(0, userId.length - AGENT_NAME_SUFFIX.length)
    : userId;
}
