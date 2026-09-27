/**
 * Fetch-once-per-key caching, with failures never cached.
 *
 * Six copies of this had accumulated — blob URLs, textures, media item names,
 * GLB models, room snapshots, rendered thumbnails — all with the same subtle
 * requirement: the *promise* goes in the map, not the value, so two callers
 * racing for the same key share one request rather than making two; and the
 * entry is removed again if it rejects, so a transient failure does not
 * poison the key for the rest of the session.
 */
export function cachedPromise<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  create: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing != null) {
    return existing;
  }

  const pending = create();
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}
