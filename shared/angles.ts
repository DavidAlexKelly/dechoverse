/** Shortest signed angle from a to b, in radians. */
export function angleDelta(from: number, to: number): number {
  return ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}
