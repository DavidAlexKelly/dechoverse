import { Streams } from "@osdk/foundry.streams";
import client from "@/foundry/client";

/**
 * Reading and writing a Foundry stream, as this app does it.
 *
 * Marks, presence and chat had each grown their own copy of this — the same
 * timestamp coercion, the same partition list cache, the same
 * paginate-every-partition-together loop, the same cursor bookkeeping — and
 * the copies had begun to drift. They differ in only three ways, which are
 * exactly the options below: how much they read per poll, whether a partition
 * nobody has read before starts at the beginning of history or at its end,
 * and whether the partition list may be reused between polls.
 *
 * The record type is the caller's; nothing here inspects a record beyond its
 * timestamp.
 */

/** Next offset to read, per partition. */
export type StreamCursor = Record<string, string>;

/** The one field this module needs of any record: when it was published. */
export interface TimestampedRecord {
  timestamp: number;
}

export interface StreamConfig {
  /** Dataset RID, or a blank/placeholder string to disable the stream. */
  rid: string;
  branch: string;
  /** Records per request. */
  pageSize: number;
  /** Never read more than this many pages per partition, per poll. */
  maxPagesPerPoll: number;
  /**
   * Where a partition that has never been read starts.
   *
   * "beginning" replays history, which is what durable marks want. "end"
   * skips it, which is what presence and chat want: yesterday's positions are
   * noise, and a backlog of messages should not be spoken at whoever just
   * loaded the page.
   */
  startAt: "beginning" | "end";
  /**
   * How long the partition list may be reused before it is fetched again.
   *
   * Zero refetches on every poll, which also keeps the end offsets fresh
   * enough to skip partitions with nothing new in them. A poll that runs
   * several times a second cannot afford that round trip and caches instead.
   */
  partitionTtlMs?: number;
}

export interface StreamClient<T extends TimestampedRecord> {
  /** False when the RID has been blanked out to switch the feature off. */
  isEnabled: () => boolean;
  publish: (records: T[]) => Promise<void>;
  /** Where the stream currently ends, for starting without any history. */
  tailCursor: () => Promise<StreamCursor>;
  /**
   * Everything published since `cursor`, and the cursor to resume from.
   *
   * `onPage` receives each page as it lands, so a caller can put records on
   * screen progressively instead of waiting for the last page of the last
   * partition. Partitions are read concurrently: sequentially, a cold start
   * costs one round trip per page *per partition* one after another.
   */
  read: (
    cursor: StreamCursor | null,
    onPage?: (records: T[]) => void,
  ) => Promise<{ records: T[]; cursor: StreamCursor }>;
  /**
   * Everything published since `since`, read by walking *back* from the end of
   * the stream rather than forward from the beginning.
   *
   * A window of N offsets holds at most N records, because offsets never
   * advance by less than one per record. That is what makes reading forward
   * from the window start safe: it cannot miss anything between there and the
   * end. Sparse offsets only mean fewer records than the window, and windows
   * may overlap — harmless for a fold that keys on an id and prefers the
   * newest record.
   */
  readBackTo: (
    since: number,
    options?: { window?: bigint; maxSteps?: number },
  ) => Promise<{ records: T[]; cursor: StreamCursor }>;
}

/** Timestamps come back as epoch millis or as an ISO string depending on path. */
function toMillis(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/** Offsets stepped back per iteration when walking towards a boundary. */
const DEFAULT_BACKWARD_WINDOW = 500n;
/** Never walk back further than this, however stale the boundary. */
const DEFAULT_MAX_BACKWARD_STEPS = 20;

export function createStreamClient<T extends TimestampedRecord>(
  config: StreamConfig,
): StreamClient<T> {
  const { rid, branch, pageSize, maxPagesPerPoll, startAt } = config;
  const partitionTtlMs = config.partitionTtlMs ?? 0;

  let partitionIds: string[] | null = null;
  let partitionsAt = 0;
  let endOffsets: Record<string, string> | null = null;

  // Deliberately not a comparison against "": pasting a RID over every empty
  // string in a file would otherwise rewrite the guard along with it.
  const isEnabled = (): boolean => rid.startsWith("ri.foundry.main.dataset.");

  async function refreshOffsets(): Promise<Record<string, string>> {
    const offsets = await Streams.getEndOffsets(client, rid, branch, { preview: true });
    partitionIds = Object.keys(offsets);
    partitionsAt = Date.now();
    endOffsets = offsets;
    return offsets;
  }

  /**
   * The partition list, refreshed when the cached one has aged out.
   *
   * Reports whether it actually refreshed, because that is the only case in
   * which the end offsets may be used to decide a partition has nothing new:
   * a cached copy can be half a minute old, and skipping against it would
   * silently drop everything published since it was taken.
   */
  async function partitions(): Promise<{ ids: string[]; refreshed: boolean }> {
    if (partitionIds == null || Date.now() - partitionsAt > partitionTtlMs) {
      await refreshOffsets();
      return { ids: partitionIds ?? [], refreshed: true };
    }
    return { ids: partitionIds, refreshed: false };
  }

  /** Reads forward from `start`, up to the page budget, one partition. */
  async function readPartition(
    partitionId: string,
    start: string | undefined,
    onPage?: (records: T[]) => void,
  ): Promise<{ start: string | undefined; collected: T[] }> {
    const collected: T[] = [];
    let offset = start;

    for (let page = 0; page < maxPagesPerPoll; page++) {
      const rows = await Streams.getRecords(client, rid, branch, {
        partitionId,
        startOffset: offset,
        limit: pageSize,
        preview: true,
      });
      if (rows.length === 0) {
        break;
      }

      const pageRecords: T[] = [];
      for (const row of rows) {
        const value = row.value as T;
        pageRecords.push({ ...value, timestamp: toMillis(value.timestamp) });
        // Offsets are sparse, so resume from one past the last one seen.
        offset = (BigInt(row.offset) + 1n).toString();
      }

      collected.push(...pageRecords);
      onPage?.(pageRecords);

      if (rows.length < pageSize) {
        break;
      }
    }

    return { start: offset, collected };
  }

  return {
    isEnabled,

    async publish(records: T[]): Promise<void> {
      if (records.length === 0 || !isEnabled()) {
        return;
      }
      await Streams.publishRecords(client, rid, branch, { records });
    },

    async tailCursor(): Promise<StreamCursor> {
      return { ...(await refreshOffsets()) };
    },

    async read(cursor, onPage) {
      const next: StreamCursor = { ...(cursor ?? {}) };
      const { ids, refreshed } = await partitions();
      // Offsets taken during this call, or nothing: see partitions().
      const fresh = refreshed ? endOffsets : null;

      // Partitions we have never seen start at their end rather than at zero,
      // where that is the mode. Settled first, with a single refresh, so the
      // reads below can all go out at once rather than pausing mid-loop.
      if (startAt === "end" && ids.some((partitionId) => next[partitionId] == null)) {
        const offsets = endOffsets ?? (await refreshOffsets());
        for (const partitionId of ids) {
          next[partitionId] = next[partitionId] ?? offsets[partitionId];
        }
      }

      const perPartition = await Promise.all(
        ids.map(async (partitionId) => {
          const start: string | undefined = next[partitionId];
          const end = fresh?.[partitionId];
          if (start != null && end != null && BigInt(start) >= BigInt(end)) {
            return { partitionId, start, collected: [] as T[] };
          }
          const result = await readPartition(partitionId, start, onPage);
          return { partitionId, ...result };
        }),
      );

      const records: T[] = [];
      for (const partition of perPartition) {
        if (partition.start != null) {
          next[partition.partitionId] = partition.start;
        }
        records.push(...partition.collected);
      }

      return { records, cursor: next };
    },

    async readBackTo(since, options) {
      const window = options?.window ?? DEFAULT_BACKWARD_WINDOW;
      const maxSteps = options?.maxSteps ?? DEFAULT_MAX_BACKWARD_STEPS;
      const offsets = await refreshOffsets();

      const perPartition = await Promise.all(
        Object.keys(offsets).map(async (partitionId) => {
          const end = BigInt(offsets[partitionId] ?? "0");
          const collected: T[] = [];
          let windowEnd = end;

          for (let step = 0; step < maxSteps; step++) {
            const start = windowEnd > window ? windowEnd - window : 0n;
            const rows = await Streams.getRecords(client, rid, branch, {
              partitionId,
              startOffset: start.toString(),
              limit: pageSize,
              preview: true,
            });

            let oldest = Number.POSITIVE_INFINITY;
            for (const row of rows) {
              const value = row.value as T;
              const timestamp = toMillis(value.timestamp);
              collected.push({ ...value, timestamp });
              oldest = Math.min(oldest, timestamp);
            }

            // Either the start of the stream, or far enough back that the
            // caller already has everything before this point.
            if (start === 0n || oldest <= since) {
              break;
            }
            windowEnd = start;
          }

          // The cursor is the end of the stream as it stood when this began,
          // so polling resumes exactly where this left off.
          return { partitionId, end: end.toString(), collected };
        }),
      );

      const cursor: StreamCursor = {};
      const records: T[] = [];
      for (const partition of perPartition) {
        cursor[partition.partitionId] = partition.end;
        records.push(...partition.collected);
      }

      return { records, cursor };
    },
  };
}
