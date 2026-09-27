/**
 * A rolling window of measurements and the percentile taken from it.
 *
 * Presence sizes its jitter buffer from two of these — how often updates
 * arrive, and how late they are relative to the playback head — and both want
 * the same behaviour: one slow sample should widen the buffer, but a run of
 * fast ones should not shrink it below the real spread.
 */
export class RollingPercentile {
  private readonly values: number[] = [];

  constructor(
    private readonly window: number,
    private readonly quantile: number,
    /** Reported until the first measurement lands. */
    private current: number = 0,
  ) {}

  /** Adds a measurement, clamped into range, and recomputes the percentile. */
  add(value: number, { min = 0, max = Number.POSITIVE_INFINITY } = {}): number {
    this.values.push(Math.min(max, Math.max(min, value)));
    if (this.values.length > this.window) {
      this.values.shift();
    }
    const sorted = [...this.values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * this.quantile));
    this.current = sorted[index];
    return this.current;
  }

  get value(): number {
    return this.current;
  }
}
