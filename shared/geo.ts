/**
 * The arithmetic that turns places into game coordinates, and back.
 *
 * Pure, and deliberately free of any Foundry import: the DEM reader, the
 * vector tiles and the terrain all need this, it is the one place a sign error
 * would put London's roads in the North Sea, and keeping it importable on its
 * own is what lets it be tested without a browser or a token.
 */

/** Mean Earth radius, metres. Spherical is ample at walking scale. */
export const EARTH_RADIUS_M = 6371008.8;

export const METRES_PER_DEGREE_LAT = (Math.PI / 180) * EARTH_RADIUS_M;

export interface LonLat {
  lon: number;
  lat: number;
}

/**
 * Game metres to longitude and latitude, about an origin.
 *
 * A local equirectangular projection: northing is exact, and easting is scaled
 * by the cosine of the sample's own latitude rather than the origin's, so the
 * scale stays true however far north you walk instead of drifting by about a
 * metre per kilometre per degree.
 *
 * x is east and z is south, because three.js looks down -z — so walking
 * forward from the spawn walks north.
 */
export function toLonLat(origin: LonLat, x: number, z: number): LonLat {
  const lat = origin.lat - z / METRES_PER_DEGREE_LAT;
  const scale = Math.cos((lat * Math.PI) / 180);
  return {
    lon: origin.lon + x / (METRES_PER_DEGREE_LAT * Math.max(scale, 1e-6)),
    lat,
  };
}

/** The exact inverse of toLonLat. */
export function fromLonLat(origin: LonLat, lon: number, lat: number): { x: number; z: number } {
  const scale = Math.cos((lat * Math.PI) / 180);
  return {
    x: (lon - origin.lon) * METRES_PER_DEGREE_LAT * Math.max(scale, 1e-6),
    z: (origin.lat - lat) * METRES_PER_DEGREE_LAT,
  };
}

// ── Web Mercator, the tile grid the basemap is cut on ───────────────────────
//
// Fractional tile coordinates are meaningful and used: a point inside a tile is
// tile + offset/extent, and these convert that straight back to a place.

export function tileXForLon(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function tileYForLat(lat: number, z: number): number {
  const φ = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * 2 ** z);
}

export function lonAtTileX(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function latAtTileY(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// ── Clipping ────────────────────────────────────────────────────────────────

export interface Point2 {
  x: number;
  z: number;
}

/**
 * The parts of a line that lie inside a square centred on the origin, as
 * separate runs.
 *
 * Segment by segment rather than point by point, because map geometry is
 * generalised: a motorway crosses a whole tile in two points twenty kilometres
 * apart, and a test that only asked whether either endpoint was nearby would
 * throw away precisely the roads that run straight past the player.
 */
export function clipPolylineToBox(points: Point2[], half: number): Point2[][] {
  const runs: Point2[][] = [];
  let run: Point2[] | null = null;

  for (let i = 1; i < points.length; i++) {
    const clipped = clipSegmentToBox(points[i - 1], points[i], half);
    if (clipped == null) {
      run = null;
      continue;
    }

    const [from, to] = clipped;
    const last = run?.[run.length - 1];
    // Continues the run only if it picks up exactly where the last left off;
    // a segment that re-entered the square elsewhere starts a new one.
    if (last != null && Math.abs(last.x - from.x) < 0.01 && Math.abs(last.z - from.z) < 0.01) {
      run?.push(to);
    } else {
      run = [from, to];
      runs.push(run);
    }
  }

  return runs.filter((candidate) => candidate.length >= 2);
}

/**
 * Liang-Barsky: the portion of a segment inside an axis-aligned square centred
 * on the origin, or null when none of it is.
 */
export function clipSegmentToBox(a: Point2, b: Point2, half: number): [Point2, Point2] | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const p = [-dx, dx, -dz, dz];
  const q = [a.x + half, half - a.x, a.z + half, half - a.z];

  let t0 = 0;
  let t1 = 1;

  for (let edge = 0; edge < 4; edge++) {
    if (p[edge] === 0) {
      // Parallel to this edge: either wholly inside it, or wholly outside.
      if (q[edge] < 0) {
        return null;
      }
      continue;
    }
    const t = q[edge] / p[edge];
    if (p[edge] < 0) {
      if (t > t1) {
        return null;
      }
      if (t > t0) {
        t0 = t;
      }
    } else {
      if (t < t0) {
        return null;
      }
      if (t < t1) {
        t1 = t;
      }
    }
  }

  return [
    { x: a.x + t0 * dx, z: a.z + t0 * dz },
    { x: a.x + t1 * dx, z: a.z + t1 * dz },
  ];
}
