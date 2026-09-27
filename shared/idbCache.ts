/**
 * A very small key/value store in IndexedDB.
 *
 * For things that are expensive to fetch, identical for every player, and
 * unchanged between sessions: the city chunks, at the moment, and nothing
 * else. Not for anything a player made — that belongs on a stream, where it
 * is shared, durable and everyone's.
 *
 * EVERY OPERATION FAILS SOFT
 * --------------------------
 * IndexedDB is unavailable in a private window in some browsers, blocked by
 * storage settings in others, and can reject a write at any time because the
 * quota is full. All of that is fine: this is a cache in front of a fetch
 * that still works. So there is no error path out of here — a failure reads
 * as a miss, and the caller goes to the network exactly as it would have on a
 * cold browser. The alternative is an app that will not start because the
 * disk is full of somebody else's photographs.
 *
 * VERSIONING IS THE CALLER'S JOB, AND IS NOT OPTIONAL
 * ---------------------------------------------------
 * Put the version in the key. Two players in the same world must agree about
 * where the buildings are, and a cache that survives a re-bake is a player
 * standing in last week's city while everyone else walks through it. That is
 * the same rule the terrain lives under — see geoterrain — and it is the one
 * thing this file cannot enforce for you, so `sweep` is offered to make
 * honouring it cheap.
 */

/** Dropped rather than kept: a read that hangs is worse than a miss. */
const OPEN_TIMEOUT_MS = 2000;

export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  /** Deletes every entry whose key does not begin with `prefix`. */
  sweep(prefix: string): Promise<void>;
}

/** What every method resolves to when there is no usable database. */
const DISABLED: KeyValueStore = {
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(),
  sweep: () => Promise.resolve(),
};

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function openDatabase(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(store)) {
        open.result.createObjectStore(store);
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("IndexedDB refused to open"));
    // A database blocked by another tab holding an old version never calls
    // either handler. Without this the first read would wait forever, and the
    // city would simply never appear.
    open.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
    setTimeout(() => reject(new Error("IndexedDB took too long to open")), OPEN_TIMEOUT_MS);
  });
}

export function openStore(name: string, store: string): KeyValueStore {
  if (typeof indexedDB === "undefined") {
    return DISABLED;
  }

  // Opened once, lazily, and never retried: a browser that refused the first
  // time will refuse the next, and the fallback costs nothing but a fetch.
  let database: Promise<IDBDatabase> | null = null;
  const connect = (): Promise<IDBDatabase> => {
    database = database ?? openDatabase(name, store);
    return database;
  };

  const transact = async <T>(
    mode: IDBTransactionMode,
    work: (objectStore: IDBObjectStore) => Promise<T>,
  ): Promise<T> => work((await connect()).transaction(store, mode).objectStore(store));

  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        const value = await transact("readonly", (objectStore) =>
          request<T | undefined>(objectStore.get(key) as IDBRequest<T | undefined>),
        );
        return value ?? null;
      } catch {
        return null;
      }
    },

    async put(key: string, value: unknown): Promise<void> {
      try {
        await transact("readwrite", (objectStore) => request(objectStore.put(value, key)));
      } catch {
        // Full, or refused. The next read misses and refetches.
      }
    },

    async sweep(prefix: string): Promise<void> {
      try {
        await transact("readwrite", async (objectStore) => {
          const keys = await request(objectStore.getAllKeys());
          for (const key of keys) {
            if (typeof key === "string" && !key.startsWith(prefix)) {
              objectStore.delete(key);
            }
          }
        });
      } catch {
        // Stale entries are wasted space, not wrong answers: they are only
        // ever read through a key that carries the current version.
      }
    },
  };
}
