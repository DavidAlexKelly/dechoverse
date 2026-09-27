import { Users } from "@osdk/foundry.admin";
import client from "@/foundry/client";

const CACHE_KEY = "fps-player-name";
const FALLBACK_KEY = "fps-user-id";

/**
 * A stable anonymous name, used before the real one resolves and whenever the
 * Admin API is unavailable (for example the api:admin-read scope is not
 * enabled). Persisted so the same browser keeps the same label.
 */
export function anonymousName(): string {
  const stored = window.localStorage.getItem(FALLBACK_KEY);
  if (stored != null && stored !== "") {
    return stored;
  }
  const created = `player-${crypto.randomUUID().slice(0, 8)}`;
  window.localStorage.setItem(FALLBACK_KEY, created);
  return created;
}

/** The last resolved display name, so a reload shows it immediately. */
export function cachedDisplayName(): string | null {
  const cached = window.localStorage.getItem(CACHE_KEY);
  return cached != null && cached !== "" ? cached : null;
}

/**
 * Looks up the signed in user's name via the Admin API.
 *
 * Returns null rather than throwing: a missing name is cosmetic, and presence
 * should never depend on it.
 */
export async function fetchDisplayName(): Promise<string | null> {
  try {
    const user = await Users.getCurrent(client);
    const full = [user.givenName, user.familyName]
      .filter((part) => part != null)
      .join(" ")
      .trim();
    const name = full !== "" ? full : user.username;
    if (name == null || name === "") {
      return null;
    }
    window.localStorage.setItem(CACHE_KEY, name);
    return name;
  } catch {
    return null;
  }
}
