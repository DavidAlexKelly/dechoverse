import { Datasets } from "@osdk/foundry";
import client from "@/foundry/client";
import type { MarkRecord } from "@/foundry/streams/marks";
import { cachedPromise } from "@/shared/promiseCache";

/**
 * [AP] Server History — the world's long-term state, one JSON file per room.
 *
 * This is a store rather than a cache of the stream. Every four hours the job
 * applies the edits since its last run on top of the state it wrote last
 * time, so anything erased is dropped rather than carried forward, and the
 * files hold what currently exists rather than everything that ever did.
 *
 * Entering a room fetches just that room's file. The stream is still read
 * afterwards and folded on top, which covers the edits since the last run. A
 * file that is stale, wrong or missing costs nothing but the speed-up,
 * because the fold keys on markId and the newest record always wins.
 *
 * Blank the RID out to disable this entirely and fall back to replaying the
 * stream, exactly as the app did before.
 */
export const SNAPSHOT_DATASET_RID = "ri.foundry.main.dataset.e94d785d-51ca-40c5-aa0e-45e6a3e05342";
export const SNAPSHOT_BRANCH = "master";

export function isSnapshotEnabled(): boolean {
  // Deliberately not a comparison against "": pasting a RID over every empty
  // string in this file would otherwise rewrite the guard along with it.
  return SNAPSHOT_DATASET_RID.startsWith("ri.foundry.main.dataset.");
}

/**
 * File name for a room: hex of the key's UTF-8 bytes.
 *
 * Must match room_file_name in the transform exactly. Hex rather than slugs
 * or percent-encoding because room keys contain colons, spaces and raw rids,
 * and hex has no dialect differences between Python's and JavaScript's
 * escaping rules to get subtly wrong.
 */
export function roomFileName(levelKey: string): string {
  const bytes = new TextEncoder().encode(levelKey);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${hex}.json`;
}

interface SnapshotFile {
  levelKey: string;
  generatedAt: number;
  markCount: number;
  marks: MarkRecord[];
}

/**
 * The file holding marks every client needs whichever room it is in: the tag
 * library, and every door.
 *
 * Both are read from the whole history rather than from one room — the
 * library is gathered from every mark carrying an imageRid, and placing a
 * door retires the player's previous one wherever it is — so neither can come
 * from a room file. This is what lets the stream's retention be shortened
 * without quietly losing uploaded images or leaving someone with two doors.
 */
const SHARED_FILE = "shared.json";

export interface Snapshot {
  marks: MarkRecord[];
  /**
   * When the state was folded, in epoch millis, or 0 when there is no file.
   *
   * This is how far back the stream has to be read: everything older is
   * already in the marks above. Every file written by a given run carries the
   * same value, so any one of them answers for all of them.
   */
  generatedAt: number;
}

/** What a missing, unreadable or disabled file resolves to. */
const MISSING: Snapshot = { marks: [], generatedAt: 0 };

/** Files already fetched this session, so re-entering a room is free. */
const cache = new Map<string, Promise<Snapshot>>();

/**
 * Fetches a room's snapshot.
 *
 * Returns an empty list rather than throwing for any failure at all — a room
 * that has never been snapshotted, a job that has not run yet, a missing
 * scope. This is an optimisation, and the stream replay behind it is still
 * the source of truth, so failing quietly to the slower path is the correct
 * behaviour rather than a swallowed error.
 */
function loadSnapshotFile(fileName: string): Promise<Snapshot> {
  if (!isSnapshotEnabled()) {
    return Promise.resolve(MISSING);
  }

  // cachedPromise drops the entry again if the fetch rejects — the next
  // attempt may land after the job has run — and the catch below turns that
  // failure into an empty snapshot, since the stream replay behind this is
  // still the source of truth.
  return cachedPromise(cache, fileName, async () => {
    const response = await Datasets.Files.content(client, SNAPSHOT_DATASET_RID, fileName, {
      branchName: SNAPSHOT_BRANCH,
    });
    const parsed = (await response.json()) as SnapshotFile;
    return {
      marks: Array.isArray(parsed.marks) ? parsed.marks : [],
      generatedAt: typeof parsed.generatedAt === "number" ? parsed.generatedAt : 0,
    };
  }).catch(() => MISSING);
}

export async function loadRoomSnapshot(levelKey: string): Promise<Snapshot> {
  return loadSnapshotFile(roomFileName(levelKey));
}

/** Doors and the tag library, needed whichever room the player is in. */
export async function loadSharedSnapshot(): Promise<Snapshot> {
  return loadSnapshotFile(SHARED_FILE);
}
