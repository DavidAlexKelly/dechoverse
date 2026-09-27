import { expect, test } from "vitest";
import {
  clipPolylineToBox,
  fromLonLat,
  latAtTileY,
  lonAtTileX,
  tileXForLon,
  tileYForLat,
  toLonLat,
} from "@/shared/geo";

/** Old Street, where DechoWorld 2's door comes out. */
const ORIGIN = { lon: -0.086967, lat: 51.525811 };

test("metres and degrees are exact inverses of each other", () => {
  for (const [x, z] of [
    [0, 0],
    [1000, -2500],
    [-4000, 4000],
    [250.5, 17.25],
  ]) {
    const { lon, lat } = toLonLat(ORIGIN, x, z);
    const back = fromLonLat(ORIGIN, lon, lat);
    expect(back.x).toBeCloseTo(x, 6);
    expect(back.z).toBeCloseTo(z, 6);
  }
});

test("north is -z and east is +x", () => {
  expect(toLonLat(ORIGIN, 0, -1000).lat).toBeGreaterThan(ORIGIN.lat);
  expect(toLonLat(ORIGIN, 1000, 0).lon).toBeGreaterThan(ORIGIN.lon);
});

/**
 * Great-circle distance, worked out independently of the projection under
 * test. Checking the projection against its own constant would only prove it
 * is self-consistent; this asks whether a kilometre in the game is a kilometre
 * on the planet.
 */
function haversineMetres(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const dφ = φ2 - φ1;
  const dλ = toRad(b.lon - a.lon);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

test("a kilometre walked is a kilometre on the ground", () => {
  // Within a centimetre in each direction, which is as true to life as a
  // spherical Earth gets and far finer than a 90 m DEM posting.
  expect(haversineMetres(ORIGIN, toLonLat(ORIGIN, 0, -1000))).toBeCloseTo(1000, 2);
  expect(haversineMetres(ORIGIN, toLonLat(ORIGIN, 1000, 0))).toBeCloseTo(1000, 2);
  /**
   * The diagonal is where a local projection shows its seams: easting is
   * scaled at the destination's latitude, so a path that moves in both axes at
   * once shears very slightly. Under a metre over four kilometres — about
   * 15 cm per km, and a hundredth of the DEM's 90 m posting — so it is a
   * property to know about rather than a fault to fix.
   */
  const diagonal = haversineMetres(ORIGIN, toLonLat(ORIGIN, 3000, 3000));
  expect(Math.abs(diagonal - Math.hypot(3000, 3000))).toBeLessThan(1);
});

test("tile coordinates round-trip through the mercator", () => {
  const z = 10;
  const x = tileXForLon(ORIGIN.lon, z);
  const y = tileYForLat(ORIGIN.lat, z);

  // The origin sits inside the tile that claims it: within its west/east and
  // north/south edges. Getting the y formula upside down still lands on a
  // plausible number, and only this catches it.
  expect(lonAtTileX(x, z)).toBeLessThanOrEqual(ORIGIN.lon);
  expect(lonAtTileX(x + 1, z)).toBeGreaterThan(ORIGIN.lon);
  expect(latAtTileY(y, z)).toBeGreaterThanOrEqual(ORIGIN.lat);
  expect(latAtTileY(y + 1, z)).toBeLessThan(ORIGIN.lat);
});

test("a line that only passes through the box is kept, not dropped", () => {
  // The regression this exists for: map geometry is generalised, so a motorway
  // running past the player is two points twenty kilometres apart with neither
  // of them anywhere near. Judging the line by its endpoints loses exactly the
  // roads worth drawing.
  const runs = clipPolylineToBox(
    [
      { x: -20000, z: 0 },
      { x: 20000, z: 0 },
    ],
    1000,
  );

  expect(runs).toHaveLength(1);
  expect(runs[0][0].x).toBeCloseTo(-1000, 6);
  expect(runs[0][1].x).toBeCloseTo(1000, 6);
});

test("clipping keeps what is inside and discards the rest", () => {
  const inside = clipPolylineToBox(
    [
      { x: -100, z: -100 },
      { x: 100, z: 100 },
    ],
    1000,
  );
  expect(inside).toEqual([
    [
      { x: -100, z: -100 },
      { x: 100, z: 100 },
    ],
  ]);

  const outside = clipPolylineToBox(
    [
      { x: 2000, z: 2000 },
      { x: 3000, z: 2500 },
    ],
    1000,
  );
  expect(outside).toEqual([]);
});

test("a line that leaves and comes back is two runs", () => {
  // A ring road crossing the square twice must not be joined up across the
  // gap, or the ribbon would draw a shortcut through the middle of the world.
  const runs = clipPolylineToBox(
    [
      { x: -2000, z: -500 },
      { x: 2000, z: -500 },
      { x: 2000, z: 500 },
      { x: -2000, z: 500 },
    ],
    1000,
  );

  expect(runs).toHaveLength(2);
  for (const run of runs) {
    for (const point of run) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(1000.000001);
      expect(Math.abs(point.z)).toBeLessThanOrEqual(1000.000001);
    }
  }
});

test("the prime meridian and the equator are where they should be", () => {
  expect(lonAtTileX(512, 10)).toBeCloseTo(0, 9);
  expect(latAtTileY(512, 10)).toBeCloseTo(0, 9);
  expect(tileXForLon(-180, 10)).toBe(0);
});
