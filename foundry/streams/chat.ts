import { type StreamCursor, createStreamClient } from "@/foundry/streams/streamClient";

/**
 * [AP] Chat Stream — proximity chat messages.
 *
 * Deliberately its own stream rather than a column on the presence stream.
 * Chat is free text typed by named users, which is a different class of data
 * from machine-generated pose telemetry, so it gets its own retention and its
 * own permissions. It also means chat keeps working when presence does not,
 * and that presence's carefully tuned schema is left alone.
 *
 * Blank the RID out to disable chat entirely.
 */
export const CHAT_STREAM_DATASET_RID =
  "ri.foundry.main.dataset.5f91bb02-5d2e-4697-8326-c66432a9a35d";
export const CHAT_STREAM_BRANCH = "master";
export const CHAT_SCHEMA_VERSION = 1;

/**
 * One message. Position travels with it so the distance gate does not depend
 * on presence being up — the two streams are read independently.
 */
export type ChatRecord = {
  timestamp: number;
  messageId: string;
  sessionId: string;
  userId: string;
  levelKey: string;
  text: string;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  schemaVersion: number;
};

export type ChatCursor = StreamCursor;

/**
 * Chat volume is tiny, so a poll never needs to read far. It starts at the end
 * of the stream: a message sent before you joined is not yours to hear, and
 * replaying history would speak a backlog at whoever loaded the page.
 */
const stream = createStreamClient<ChatRecord>({
  rid: CHAT_STREAM_DATASET_RID,
  branch: CHAT_STREAM_BRANCH,
  pageSize: 100,
  maxPagesPerPoll: 2,
  startAt: "end",
  partitionTtlMs: 30000,
});

export function isChatEnabled(): boolean {
  return stream.isEnabled();
}

/** Publishes a message. One record per message, so this is never batched. */
export async function publishChat(records: ChatRecord[]): Promise<void> {
  return stream.publish(records);
}

/** Where the stream currently ends, so nothing historic is ever spoken. */
export async function chatTailCursor(): Promise<ChatCursor> {
  return stream.tailCursor();
}

/** Reads everything published since the cursor and advances it. */
export async function readChat(
  cursor: ChatCursor,
): Promise<{ records: ChatRecord[]; cursor: ChatCursor }> {
  return stream.read(cursor);
}
