import { type StreamCursor, createStreamClient } from "@/foundry/streams/streamClient";

/**
 * Live player positions are published here, and read straight back off the
 * stream — this is exhaust rather than a record of anything, so history is
 * skipped entirely and nothing is ever replayed.
 *
 * Blank the RID out to disable presence entirely.
 */
export const PRESENCE_STREAM_DATASET_RID =
  "ri.foundry.main.dataset.8a2d3d62-5ff0-4418-ab0c-b04ba7ab2d85";
export const PRESENCE_STREAM_BRANCH = "master";
/** v2 adds vx / vz. Records without them still interpolate, just without tangents. */
export const PRESENCE_SCHEMA_VERSION = 2;

export type PresenceState = "alive" | "left";

export type PresenceRecord = {
  timestamp: number;
  sessionId: string;
  userId: string;
  levelKey: string;
  state: PresenceState;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  yaw?: number | null;
  pitch?: number | null;
  /** Horizontal velocity in metres per second, for Hermite interpolation. */
  vx?: number | null;
  vz?: number | null;
  weapon?: string | null;
  schemaVersion: number;
};

export type PresenceCursor = StreamCursor;

/**
 * Presence polls several times a second, so the partition list is cached: asking
 * for it every time would make a poll two round trips instead of one, and that
 * lands directly on how stale everyone else's avatar is.
 */
const stream = createStreamClient<PresenceRecord>({
  rid: PRESENCE_STREAM_DATASET_RID,
  branch: PRESENCE_STREAM_BRANCH,
  pageSize: 200,
  maxPagesPerPoll: 4,
  startAt: "end",
  partitionTtlMs: 30000,
});

export function isPresenceEnabled(): boolean {
  return stream.isEnabled();
}

/** Fire-and-forget pose update. */
export async function publishPresence(records: PresenceRecord[]): Promise<void> {
  return stream.publish(records);
}

/** Where the stream currently ends; presence has no useful history. */
export async function presenceTailCursor(): Promise<PresenceCursor> {
  return stream.tailCursor();
}

/** Reads everything published since the cursor and advances it. */
export async function readPresence(
  cursor: PresenceCursor,
): Promise<{ records: PresenceRecord[]; cursor: PresenceCursor }> {
  return stream.read(cursor);
}
