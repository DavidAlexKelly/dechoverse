/**
 * usePolling without React.
 *
 * The same two guarantees, for code that lives outside a component: the first
 * tick waits for `prepare` (which is where a cursor is settled), and a slow
 * tick is never overlapped by the next one — re-entrant calls are dropped
 * rather than queued.
 */
export interface PollerOptions {
  prepare?: (isCancelled: () => boolean) => Promise<void>;
  tick: (isCancelled: () => boolean) => Promise<void>;
  intervalMs: number;
}

/** Starts the loop and returns the function that stops it. */
export function startPolling({ prepare, tick, intervalMs }: PollerOptions): () => void {
  let cancelled = false;
  let inFlight = false;
  const isCancelled = (): boolean => cancelled;

  const run = async (): Promise<void> => {
    if (inFlight || cancelled) {
      return;
    }
    inFlight = true;
    try {
      await tick(isCancelled);
    } catch {
      // A tick reports its own errors; one that throws must not kill the loop.
    } finally {
      inFlight = false;
    }
  };

  void (async () => {
    if (prepare != null) {
      inFlight = true;
      try {
        await prepare(isCancelled);
      } catch {
        // As above: a failed prepare falls through to polling from scratch.
      } finally {
        inFlight = false;
      }
    }
    await run();
  })();

  const interval = window.setInterval(() => void run(), intervalMs);
  return () => {
    cancelled = true;
    window.clearInterval(interval);
  };
}
