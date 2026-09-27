/**
 * A random number in [0, 1), from the browser's cryptographic generator.
 *
 * For the few places that genuinely want randomness — an agent picking
 * somewhere to wander. Math.random is flagged by the linter as an insecure
 * source of randomness, and anything that must match on every client (the
 * world, the city) must not be random at all.
 */
export function randomFloat(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  // 2^32: the largest Uint32 plus one, so the result never reaches 1.
  return buffer[0] / 4294967296;
}
