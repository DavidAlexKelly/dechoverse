import { useEffect, useRef } from "react";

interface Options {
  /**
   * Runs once, before the first tick, and the first tick waits for it.
   *
   * This is where a cursor is established — the tail of the stream for
   * presence and chat, the boundary of the last snapshot for marks. Doing it
   * inside the tick instead would let the interval fire a second, competing
   * read before the first had settled where to start from.
   */
  prepare?: (isCancelled: () => boolean) => Promise<void>;
  /** One poll. Re-entrant calls are dropped rather than queued. */
  tick: (isCancelled: () => boolean) => Promise<void>;
  intervalMs: number;
  /** False leaves the loop entirely unstarted, for a disabled feature. */
  enabled?: boolean;
}

/**
 * Polls a stream on an interval, with the bookkeeping every one of these
 * loops needs and used to carry its own copy of: a cancellation flag checked
 * after each await so an unmounted hook cannot write state, and an in-flight
 * guard so a slow read is never overlapped by the next tick.
 *
 * The callbacks are held in refs, so a caller does not have to memoise them to
 * keep the loop from being torn down and restarted on every render.
 */
export function usePolling({ prepare, tick, intervalMs, enabled = true }: Options): void {
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const isCancelled = (): boolean => cancelled;

    const run = async (): Promise<void> => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        await tickRef.current(isCancelled);
      } finally {
        inFlight = false;
      }
    };

    void (async () => {
      if (prepareRef.current != null) {
        // Held open so the interval below cannot start a read before the
        // cursor is settled; a failure in prepare must not stop the polling.
        inFlight = true;
        try {
          await prepareRef.current(isCancelled);
        } finally {
          inFlight = false;
        }
      }
      if (!cancelled) {
        await run();
      }
    })();

    const interval = window.setInterval(() => void run(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled, intervalMs]);
}
