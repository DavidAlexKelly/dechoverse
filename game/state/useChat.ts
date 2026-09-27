import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "@/foundry/errors";
import {
  CHAT_SCHEMA_VERSION,
  type ChatCursor,
  type ChatRecord,
  chatTailCursor,
  isChatEnabled,
  publishChat,
  readChat,
} from "@/foundry/streams/chat";
import { MAX_MESSAGE_LENGTH, bubbleDurationMs, isShout, speak } from "@/game/state/speech";
import { usePolling } from "@/game/state/usePolling";
import type { PlayerTrack, Pose } from "@/game/state/usePresence";

/** Chat is human paced, so it polls far more slowly than presence does. */
const POLL_INTERVAL_MS = 500;
/** How often expired bubbles are swept off the screen. */
const EXPIRY_TICK_MS = 150;
/** Everyone within this many metres hears a normal message. */
export const HEARING_RADIUS = 32;
/** Shouting — all capitals — carries considerably further. */
export const SHOUT_RADIUS = 45;
/** No attenuation at all inside this radius. */
const FULL_VOLUME_RADIUS = 6;
/**
 * Volume at the very edge of earshot.
 *
 * Deliberately well above zero. Tapering all the way to silence means the
 * outer third of the range is inaudible in practice, so someone two metres
 * inside the limit cannot be made out at all. Fading to this instead keeps a
 * distant voice quiet but clear, and then it stops being heard at the
 * boundary rather than dwindling to nothing before it.
 */
const EDGE_VOLUME = 0.35;
/** All capitals doubles the volume, at every distance. */
const SHOUT_GAIN = 2;
/**
 * A message this far behind is dropped rather than spoken late — the case
 * being a background tab that was throttled and woke up to a backlog.
 * Requires a presence clock offset to evaluate, so it is best effort.
 */
const MAX_STALENESS_MS = 4000;
/** Bounded dedupe set. Chat volume is tiny, so this is very generous. */
const SEEN_LIMIT = 200;

/** A message currently on screen. */
export interface ActiveMessage {
  text: string;
  userId: string;
  /** Local-clock time the bubble should disappear. */
  until: number;
}

export interface Chat {
  /** Live messages from other players, keyed by sessionId. */
  speech: Map<string, ActiveMessage>;
  /** This player's own message, driving the HUD chip and the send lock. */
  mine: ActiveMessage | null;
  /** True while the previous message is still on screen. */
  locked: boolean;
  send: (text: string) => void;
  enabled: boolean;
  error: string | null;
}

interface Options {
  levelKey: string;
  sessionId: string;
  userId: string;
  /** Local camera pose, for the distance gate. */
  poseRef: React.MutableRefObject<Pose | null>;
  /**
   * Presence tracks, used only to age an arriving record for the staleness
   * check. Chat is fully functional without them.
   */
  tracksRef?: React.MutableRefObject<Map<string, PlayerTrack>>;
}

/**
 * Distance attenuation. Flat inside FULL_VOLUME_RADIUS, then tapering to
 * EDGE_VOLUME at the edge of range — not to silence — and cutting out
 * entirely beyond it.
 *
 * Shouting doubles the result and widens the range. Note that utterance
 * volume is capped at 1 by the speech API, so the doubling only has room to
 * show itself once distance has attenuated the voice below half: close up,
 * a shout and a normal message are both already at maximum.
 */
function volumeFor(record: ChatRecord, pose: Pose | null, shout: boolean): number {
  const gain = shout ? SHOUT_GAIN : 1;
  const radius = shout ? SHOUT_RADIUS : HEARING_RADIUS;

  if (pose == null || record.x == null || record.z == null) {
    // Nothing to compare: assume audible rather than silently swallowing it.
    return Math.min(1, gain);
  }

  const distance = Math.hypot(record.x - pose.x, record.z - pose.z);
  if (distance > radius) {
    return 0;
  }
  if (distance <= FULL_VOLUME_RADIUS) {
    return Math.min(1, gain);
  }

  const travelled = (distance - FULL_VOLUME_RADIUS) / (radius - FULL_VOLUME_RADIUS);
  const attenuated = 1 - travelled * (1 - EDGE_VOLUME);
  return Math.min(1, attenuated * gain);
}

/**
 * Proximity chat over the [AP] Chat Stream.
 *
 * Sends one record per message and tails the stream from its end, so history
 * is never replayed. A bubble's *duration* comes from the text itself, so no
 * duration travels on the wire; its *start* is when the message arrived,
 * which guarantees everyone sees it in full. That same timer gates sending
 * the next message.
 */
export function useChat({ levelKey, sessionId, userId, poseRef, tracksRef }: Options): Chat {
  const [speech, setSpeech] = useState<Map<string, ActiveMessage>>(
    () => new Map<string, ActiveMessage>(),
  );
  const [mine, setMine] = useState<ActiveMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<ChatCursor | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  /** Mirror of `mine`, so `send` can check the lock without being rebuilt. */
  const mineRef = useRef<ActiveMessage | null>(null);
  /** Kept in a ref so the poller never restarts when the room changes. */
  const contextRef = useRef({ levelKey, sessionId, userId });
  contextRef.current = { levelKey, sessionId, userId };

  const applyRecords = useCallback(
    (records: ChatRecord[]) => {
      if (records.length === 0) {
        return;
      }
      const now = Date.now();
      const context = contextRef.current;
      const additions: Array<[string, ActiveMessage]> = [];

      for (const record of records) {
        // Our own message is already on screen and was already spoken locally.
        if (record.sessionId === context.sessionId) {
          continue;
        }
        if (record.messageId == null || record.text == null || record.text === "") {
          continue;
        }
        // Delivery is at-least-once, so the same message can arrive twice.
        if (seenRef.current.has(record.messageId)) {
          continue;
        }
        seenRef.current.add(record.messageId);
        if (seenRef.current.size > SEEN_LIMIT) {
          // Sets iterate in insertion order, so the oldest key comes first.
          const oldest = seenRef.current.values().next().value;
          if (oldest != null) {
            seenRef.current.delete(oldest);
          }
        }

        // Chat does not cross rooms.
        if (record.levelKey !== context.levelKey) {
          continue;
        }

        // Bubbles are anchored to arrival, not to the sender's clock.
        //
        // Borrowing presence's min-filtered offset looked more precise, but it
        // is the wrong offset for this stream: it is the *minimum* latency
        // observed on a 150ms poll, whereas chat arrives on a 500ms one. Every
        // message therefore looked late by the difference and had its bubble
        // truncated by that much — sometimes to nothing at all. Anchoring at
        // arrival costs at most one poll interval of desync between viewers,
        // which nobody can perceive in a chat message, and guarantees everyone
        // sees it for its full duration.
        const offset = tracksRef?.current.get(record.sessionId)?.offset ?? null;
        // The offset is still the only trustworthy way to age a record, since
        // comparing raw clocks across two machines is meaningless. Guards
        // against a throttled background tab waking up to a backlog.
        if (offset != null && now - (record.timestamp + offset) > MAX_STALENESS_MS) {
          continue;
        }
        const until = now + bubbleDurationMs(record.text);

        additions.push([record.sessionId, { text: record.text, userId: record.userId, until }]);

        // The bubble is visible anywhere in the room; only the audio is
        // proximity gated. So you can see someone talking across the arena and
        // simply not hear them.
        const volume = volumeFor(record, poseRef.current, isShout(record.text));
        if (volume > 0) {
          speak(record.text, { volume, seed: record.sessionId });
        }
      }

      if (additions.length === 0) {
        return;
      }
      setSpeech((previous) => {
        const next = new Map(previous);
        for (const [speaker, message] of additions) {
          next.set(speaker, message);
        }
        return next;
      });
    },
    [poseRef, tracksRef],
  );

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (text === "") {
        return;
      }
      // One message at a time: the previous bubble must have expired.
      if (mineRef.current != null && Date.now() < mineRef.current.until) {
        return;
      }

      const context = contextRef.current;
      const pose = poseRef.current;
      const timestamp = Date.now();
      const message: ActiveMessage = {
        text,
        userId: context.userId,
        until: timestamp + bubbleDurationMs(text),
      };
      mineRef.current = message;
      setMine(message);

      // Speak locally straight away rather than waiting for the message to
      // come back around through the stream: the sender should hear themselves
      // immediately, and their own records are filtered out on read.
      speak(text, { volume: 1, seed: context.sessionId });

      void publishChat([
        {
          timestamp,
          messageId: crypto.randomUUID(),
          sessionId: context.sessionId,
          userId: context.userId,
          levelKey: context.levelKey,
          text,
          x: pose?.x ?? null,
          y: pose?.y ?? null,
          z: pose?.z ?? null,
          schemaVersion: CHAT_SCHEMA_VERSION,
        },
      ]).catch((publishError: unknown) => {
        setError(`publish: ${describeError(publishError)}`);
      });
    },
    [poseRef],
  );

  // Tail the stream. Starts at the end, so nothing historic is ever spoken.
  usePolling({
    prepare: async (isCancelled) => {
      try {
        const cursor = await chatTailCursor();
        if (!isCancelled()) {
          cursorRef.current = cursor;
        }
      } catch (readError) {
        // A null cursor simply has the tick try again on the next poll.
        if (!isCancelled()) {
          setError(`read: ${describeError(readError)}`);
        }
      }
    },
    tick: async (isCancelled) => {
      try {
        cursorRef.current = cursorRef.current ?? (await chatTailCursor());
        const result = await readChat(cursorRef.current);
        if (isCancelled()) {
          return;
        }
        cursorRef.current = result.cursor;
        applyRecords(result.records);
      } catch (readError) {
        if (!isCancelled()) {
          setError(`read: ${describeError(readError)}`);
        }
      }
    },
    intervalMs: POLL_INTERVAL_MS,
    enabled: isChatEnabled(),
  });

  // Sweep expired bubbles. This is also what releases the send lock.
  useEffect(() => {
    const interval = window.setInterval(() => {
      const now = Date.now();

      if (mineRef.current != null && now >= mineRef.current.until) {
        mineRef.current = null;
        setMine(null);
      }

      setSpeech((previous) => {
        let expired = false;
        for (const message of previous.values()) {
          if (now >= message.until) {
            expired = true;
            break;
          }
        }
        if (!expired) {
          return previous;
        }
        const next = new Map<string, ActiveMessage>();
        for (const [speaker, message] of previous) {
          if (now < message.until) {
            next.set(speaker, message);
          }
        }
        return next;
      });
    }, EXPIRY_TICK_MS);
    return () => window.clearInterval(interval);
  }, []);

  // Leaving a room drops everyone else's bubbles. The player's own message is
  // left alone, so walking through a door cannot shake off the send lock.
  useEffect(() => {
    setSpeech((previous) => (previous.size === 0 ? previous : new Map()));
  }, [levelKey]);

  return {
    speech,
    mine,
    locked: mine != null,
    send,
    enabled: isChatEnabled(),
    error,
  };
}
