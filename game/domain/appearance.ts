import type { Appearance } from "@/game/domain/types";

/**
 * Body colours, and what a player looks like before they have chosen anything.
 */

/** The colours a player is given, and the ones the wheel's presets sit beside. */
export const AVATAR_PALETTE = [
  "#00d2ff",
  "#00ffb2",
  "#ffd166",
  "#ff5c8a",
  "#b980ff",
  "#7afcff",
  "#b0ff6b",
  "#ff8f4d",
];

/** Stable hash, matching how speech picks a voice per player. */
function hashOf(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100000;
  }
  return hash;
}

/**
 * The colour a player has until they pick one.
 *
 * Keyed on the player's name rather than their session: a session is new on
 * every reload, so the old behaviour was that everyone changed colour whenever
 * they refreshed the page. A name is the closest thing this game has to a
 * person, so an unchosen colour is at least the same colour tomorrow.
 */
export function defaultColorFor(userId: string): string {
  return AVATAR_PALETTE[hashOf(userId) % AVATAR_PALETTE.length];
}

/** A player who has never opened the character screen. */
export function defaultAppearance(userId: string): Appearance {
  return { color: defaultColorFor(userId), hat: null, hatColor: null };
}
