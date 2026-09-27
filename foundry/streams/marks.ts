import { type StreamCursor, createStreamClient } from "@/foundry/streams/streamClient";

/** [AP] Server State — the append-only log of every mark anyone has made. */
export const MARK_STREAM_DATASET_RID =
  "ri.foundry.main.dataset.4554c9be-9723-4776-9905-3869307ed837";
export const MARK_STREAM_BRANCH = "master";
/** v2 adds `points`, carrying a whole spray stroke in a single record. */
export const MARK_SCHEMA_VERSION = 2;

/**
 * One row of the stream. A create carries the full geometry; an erase writes
 * the same markId back with `deleted: true` and nothing else, and the fold
 * treats the newest timestamp per markId as the truth.
 */
export type MarkRecord = {
  timestamp: number;
  markId: string;
  levelKey: string;
  deleted: boolean;
  userId: string;
  sessionId?: string | null;
  kind?: string | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  qx?: number | null;
  qy?: number | null;
  qz?: number | null;
  qw?: number | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  color?: string | null;
  imageRid?: string | null;
  /** Encoded dabs or pads for a "stroke" or "sweep" record. Null otherwise. */
  points?: string | null;
  schemaVersion: number;
};

export type { StreamCursor };

/**
 * Marks are durable, so a partition nobody has read starts at the beginning of
 * history. End offsets are refreshed on every poll (a 1.5 s cadence can afford
 * the round trip) which is also what lets a partition with nothing new in it
 * be skipped without reading it.
 */
const stream = createStreamClient<MarkRecord>({
  rid: MARK_STREAM_DATASET_RID,
  branch: MARK_STREAM_BRANCH,
  pageSize: 500,
  // Safety valve so a very long stream cannot spin forever on first load.
  maxPagesPerPoll: 20,
  startAt: "beginning",
  partitionTtlMs: 0,
});

/** Publishes a batch of marks. Called once per stroke, not once per tick. */
export async function publishMarks(records: MarkRecord[]): Promise<void> {
  return stream.publish(records);
}

/** Reads everything since `cursor`, replaying from the start when it is null. */
export async function readMarks(
  cursor: StreamCursor | null,
  onPage?: (records: MarkRecord[]) => void,
): Promise<{ records: MarkRecord[]; cursor: StreamCursor }> {
  return stream.read(cursor, onPage);
}

/**
 * Everything published since `since`, read from the tail backwards.
 *
 * [AP] Server History already holds every mark as of the fold that wrote it,
 * so replaying from offset zero re-reads the entire history of the world to
 * learn nothing. Reading only the tail makes a cold start cost the fold
 * interval rather than the age of the world.
 */
export async function readMarksSince(
  since: number,
): Promise<{ records: MarkRecord[]; cursor: StreamCursor }> {
  return stream.readBackTo(since);
}
