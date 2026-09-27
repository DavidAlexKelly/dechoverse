/**
 * Who may open the /agents console and run AI players.
 *
 * Display names as the Admin API returns them (the same name shown over a
 * player's head). An empty list lets anyone who can sign in to Dechoverse run
 * agents — convenient while trying it out, and worth closing once it works.
 *
 * A convenience, not a security boundary: the streams are writable by anyone
 * who can reach them. It keeps the console out of casual reach; real control
 * comes from who has access to the app and its OpenRouter key.
 */
export const AGENT_OPERATORS: string[] = [];

export function isOperator(displayName: string | null): boolean {
  if (AGENT_OPERATORS.length === 0) {
    return true;
  }
  return displayName != null && AGENT_OPERATORS.includes(displayName);
}
