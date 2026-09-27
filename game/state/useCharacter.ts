import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeError } from "@/foundry/errors";
import {
  CHARACTER_SCHEMA_VERSION,
  type CharacterCursor,
  type CharacterRecord,
  isCharacterStreamEnabled,
  publishCharacter,
  readCharacters,
} from "@/foundry/streams/characters";
import { defaultAppearance } from "@/game/domain/appearance";
import type { Appearance } from "@/game/domain/types";
import { usePolling } from "@/game/state/usePolling";

/** Appearance changes are rare, so this polls far more slowly than chat. */
const POLL_INTERVAL_MS = 5000;

/** Where this browser remembers what you chose, so a reload is not a wait. */
const CACHE_KEY = "fps-character";

interface Options {
  /** The player's display name, which is what a record is keyed on. */
  userId: string;
}

export interface CharacterSync {
  /**
   * Everyone's appearance, keyed by userId. Players who have never chosen are
   * absent rather than defaulted, so the renderer can tell "no choice" from
   * "chose the colour we would have given them".
   */
  appearances: Map<string, Appearance>;
  /** This player's appearance, with defaults filled in. */
  mine: Appearance;
  /** Applies an appearance locally and publishes it. */
  save: (appearance: Appearance) => void;
  error: string | null;
}

/** What this browser last saw itself wearing, if anything. */
function cachedAppearance(): Appearance | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw == null) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    if (typeof parsed.color !== "string") {
      return null;
    }
    return {
      color: parsed.color,
      hat: typeof parsed.hat === "string" ? parsed.hat : null,
      hatColor: typeof parsed.hatColor === "string" ? parsed.hatColor : null,
    };
  } catch {
    // A blocked or corrupt localStorage just means falling back to the stream.
    return null;
  }
}

function cacheAppearance(appearance: Appearance): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(appearance));
  } catch {
    // Not being able to remember it locally does not stop it being published.
  }
}

/**
 * Reads [AP] Characters and keeps everyone's appearance to hand.
 *
 * The fold is the same shape as the mark stream's: newest record per key wins,
 * so records may arrive in any order and be read twice without harm. The key
 * here is the player's name rather than a mark id.
 *
 * Your own choice is also kept in localStorage, the way the display name is,
 * so the character screen and your avatar are right immediately on load rather
 * than after the first read — and stay right if the stream is unreachable.
 */
export function useCharacter({ userId }: Options): CharacterSync {
  const [records, setRecords] = useState<Map<string, CharacterRecord>>(
    () => new Map<string, CharacterRecord>(),
  );
  const [local, setLocal] = useState<Appearance | null>(() => cachedAppearance());
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<CharacterCursor | null>(null);
  /** In a ref so `save` is not rebuilt whenever anyone changes clothes. */
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const apply = useCallback((incoming: CharacterRecord[]) => {
    if (incoming.length === 0) {
      return;
    }
    setRecords((previous) => {
      let changed = false;
      const next = new Map(previous);
      for (const record of incoming) {
        if (record.userId == null || record.color == null) {
          continue;
        }
        const existing = next.get(record.userId);
        if (existing != null && existing.timestamp >= record.timestamp) {
          continue;
        }
        next.set(record.userId, record);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, []);

  usePolling({
    tick: async (isCancelled) => {
      try {
        const result = await readCharacters(cursorRef.current);
        if (isCancelled()) {
          return;
        }
        cursorRef.current = result.cursor;
        apply(result.records);
      } catch (readError) {
        if (!isCancelled()) {
          setError(`read: ${describeError(readError)}`);
        }
      }
    },
    intervalMs: POLL_INTERVAL_MS,
    enabled: isCharacterStreamEnabled(),
  });

  const appearances = useMemo(() => {
    const byUser = new Map<string, Appearance>();
    for (const record of records.values()) {
      byUser.set(record.userId, {
        color: record.color,
        hat: record.hat ?? null,
        hatColor: record.hatColor ?? null,
      });
    }
    // Whatever this browser chose outranks what the stream says about us: it
    // is newer than anything that could have been read back, and it is what
    // the character screen is showing.
    if (local != null) {
      byUser.set(userId, local);
    }
    return byUser;
  }, [records, local, userId]);

  const mine = useMemo(
    () => appearances.get(userId) ?? defaultAppearance(userId),
    [appearances, userId],
  );

  const save = useCallback(
    (appearance: Appearance) => {
      setLocal(appearance);
      cacheAppearance(appearance);

      const record: CharacterRecord = {
        timestamp: Date.now(),
        userId: userIdRef.current,
        color: appearance.color,
        hat: appearance.hat,
        hatColor: appearance.hatColor,
        schemaVersion: CHARACTER_SCHEMA_VERSION,
      };
      // Folded in locally as well, so a failed publish still leaves the world
      // agreeing with the screen until the next read says otherwise.
      apply([record]);
      void publishCharacter([record]).catch((publishError: unknown) => {
        setError(`publish: ${describeError(publishError)}`);
      });
    },
    [apply],
  );

  /*
   * A name that arrives late leaves the choice filed under the wrong player.
   *
   * The display name starts as a cached or anonymous stand-in and is replaced
   * once the Admin API answers, so anything chosen in between was published
   * under a name nobody else knows us by. Re-publishing on the change puts it
   * back under the real one.
   *
   * Deliberately only on a *change*, never on first assignment: reacting to
   * "the stream has no record of me yet" instead would write a record on every
   * single page load.
   */
  const lastUserIdRef = useRef(userId);
  useEffect(() => {
    const previous = lastUserIdRef.current;
    lastUserIdRef.current = userId;
    if (previous === userId || local == null) {
      return;
    }
    save(local);
  }, [userId, local, save]);

  return { appearances, mine, save, error };
}
