import { type StreamCursor, createStreamClient } from "@/foundry/streams/streamClient";

/**
 * [AP] Characters — what every player has chosen to look like.
 *
 * Unlike the other three streams, here the history *is* the state: one record
 * per change, folded to the newest per userId. That is why it is read from the
 * beginning rather than from the tail — and why it can be, since a record is
 * only written when somebody changes their appearance, so the whole stream is
 * a few rows per player for the life of the app.
 *
 * Keyed on userId in Foundry, which guarantees a single player's records stay
 * in order. The fold does not depend on that (it compares timestamps), but it
 * makes two changes in the same millisecond resolve the right way round.
 *
 * Deliberately not a column on the presence stream, which would deliver
 * appearance with every pose and cost nothing to read: presence has a fixed
 * schema on the busiest path in the app, and a hat is not worth a migration
 * there. The price is that a change reaches other players on their next poll
 * of this stream rather than instantly.
 *
 * Blank the RID out to keep appearance local to each browser.
 */
export const CHARACTER_STREAM_DATASET_RID =
  "ri.foundry.main.dataset.7ca366a9-454d-4c83-be11-b51f5d36fa17";
export const CHARACTER_STREAM_BRANCH = "master";
/** v2 adds hatColor. Records without it wear the hat's own colours. */
export const CHARACTER_SCHEMA_VERSION = 2;

/**
 * One appearance, as published. A null hat is a bare head, and a null
 * hatColor leaves the hat the colour it was modelled.
 */
export type CharacterRecord = {
  timestamp: number;
  userId: string;
  color: string;
  hat?: string | null;
  hatColor?: string | null;
  schemaVersion: number;
};

export type CharacterCursor = StreamCursor;

const stream = createStreamClient<CharacterRecord>({
  rid: CHARACTER_STREAM_DATASET_RID,
  branch: CHARACTER_STREAM_BRANCH,
  pageSize: 500,
  // Generous: this is the only stream read from offset zero, but it is also by
  // far the smallest, and a cold start has to see everyone's choices.
  maxPagesPerPoll: 20,
  startAt: "beginning",
  partitionTtlMs: 0,
});

export function isCharacterStreamEnabled(): boolean {
  return stream.isEnabled();
}

/** Publishes one appearance. Called when the character screen is closed. */
export async function publishCharacter(records: CharacterRecord[]): Promise<void> {
  return stream.publish(records);
}

/** Reads everything since `cursor`, or the whole stream when it is null. */
export async function readCharacters(
  cursor: CharacterCursor | null,
): Promise<{ records: CharacterRecord[]; cursor: CharacterCursor }> {
  return stream.read(cursor);
}
