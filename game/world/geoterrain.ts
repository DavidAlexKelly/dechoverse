/**
 * DechoWorld 2: the ground is a real place.
 *
 * Where DechoWorld invents its landscape from noise, this one reads the
 * Copernicus GLO-90 DEM out of Foundry and walks it at 1:1 — a metre in the
 * game is a metre on the ground, so the rise out of the Thames valley is as
 * long and as gentle as the walk really is.
 *
 * THE SHAPE OF THE PROBLEM
 * ------------------------
 * Everything above this file wants a synchronous `(x, z) => height`: the mesh
 * builds a chunk in one pass, and the collision sweep probes the ground a
 * couple of hundred times a frame. Nothing in it may await. So the whole cost
 * is paid once at the door — one DEM cell, a few megabytes, covering 220 km in
 * each direction — and after that every sample is arithmetic over an array in
 * memory. A player would have to walk for twelve hours to leave the cell they
 * spawned in, so the edges are handled lazily and never waited for.
 *
 * DETERMINISM, WHICH IS NOT OPTIONAL
 * ----------------------------------
 * Nothing about the terrain is stored or synchronised: every client computes
 * the ground and must arrive at the same answer, or players float over each
 * other's hillsides. That holds here for a better reason than it does for the
 * noise — the DEM is the same bytes for everyone — but it puts one hard rule on
 * this file: a sample must never quietly fall back to a different answer while
 * data is loading. Hence the load gate in Game, and hence "not loaded" reading
 * as the sea floor rather than as zero.
 *
 * THE VERTICAL DATUM
 * ------------------
 * Heights come out of the DEM as metres above sea level, and the spawn point is
 * not at sea level. Rather than drop the player into the inside of a mountain,
 * the whole world is shifted down by the spawn's own elevation, so the ground
 * under your feet at the door is y = 0 — exactly as in every other room. Only a
 * constant is involved, so the terrain is still life size; the sea plane moves
 * down with it, which is why the renderer takes its level from here.
 */
import {
  cellFailure,
  cellFor,
  cellIsAbsent,
  heightAtLoaded,
  residentCell,
  sampleGrid,
  warmCell,
} from "@/foundry/elevation";
import {
  GRASS,
  GRASS_DARK,
  type HeightField,
  ROCK,
  SAND,
  SNOW,
  fbm,
  mix,
  valueNoise,
} from "@/game/world/worldgen";
import { toLonLat } from "@/shared/geo";

/**
 * Where the door comes out: Old Street, London.
 *
 * It sits in DEM cell c089_r016, which covers 2°W-0°E and 51-53°N — so the one
 * chunk loaded at the door holds London, the Chilterns, the North Downs and
 * the Thames estuary, and you could walk to any of them without another byte
 * being fetched.
 *
 * WORTH KNOWING WHAT THIS PLACE LOOKS LIKE IN A DEM. London is flat and low:
 * about 20 m above sea level here, with nothing steeper than the Islington
 * slope for miles. GLO-90 is a surface of bare ground at a 90 m posting, so
 * there are no buildings and no streets in it — this is the ground London is
 * built on, not London. It is the terrain that is real, not the city.
 */
export const ANCHOR = { lon: -0.086967, lat: 51.525811 };

/**
 * The sea floor reported where there is no land: DEM voids, which is how GLO
 * records the sea and most lakes, and cells that are not loaded.
 *
 * Below the water plane rather than at it, so a shoreline reads as shallows
 * you can wade into rather than as a wall at the water's edge.
 */
const SEA_FLOOR = -3;

export interface GeoTerrain {
  /** Ground height in game metres. Synchronous; safe in the collision sweep. */
  height: HeightField;
  /** Vertex colour, banded for real elevations rather than the noise's range. */
  color: (x: number, z: number, height: number) => [number, number, number];
  /**
   * Metres of real elevation subtracted from every sample, so the spawn is at
   * y = 0. The renderer puts the sea at minus this.
   */
  datum: number;
  /** Where the origin of the game's coordinates actually is. */
  origin: { lon: number; lat: number };
}

/**
 * Small-scale relief added on top of the DEM.
 *
 * GLO-90 has one measurement every 90 m, so interpolated on its own it is
 * correct and completely smooth — real mountains rendered as if sanded. This
 * puts the old world's own noise back on as texture only: about a metre at a
 * 90 m wavelength and half of that at 20 m, which is enough for the flat
 * shading to catch and far too small to move a ridge or fill a valley.
 *
 * KEPT SMALL BECAUSE THIS GROUND IS FLAT. On a mountainside a couple of metres
 * of noise vanishes into the slope, but London is level enough that the same
 * amount would read as dunes across Hackney — inventing terrain in exactly the
 * place where the real answer is "it is flat".
 *
 * Faded out towards the waterline, so the sea stays a sea rather than chop.
 */
function detail(x: number, z: number, height: number): number {
  const broad = (fbm(x * 0.011, z * 0.011, 3) - 0.5) * 1.6;
  const fine = (fbm(x * 0.05, z * 0.05, 2) - 0.5) * 0.8;
  const ashore = Math.max(0, Math.min(1, height / 4));
  return (broad + fine) * ashore;
}

/**
 * Colour bands for real elevations.
 *
 * The procedural world's palette turns to rock at 26 m and snow at 78 m, which
 * on actual terrain would put a bare rock summit on Hampstead Heath. These are
 * the bands for a real landscape: beach at the waterline, green through the
 * lowlands, bare rock from about 950 m and snow from about 1,400 m — so
 * London is field green, the Chilterns are barely darker, and the bands above
 * them exist for the cells this one is a neighbour of.
 *
 * Height comes in as the game's y, so the datum is added back before banding —
 * the snow line is a fact about the mountain, not about where the door is.
 */
function geoColor(
  datum: number,
): (x: number, z: number, height: number) => [number, number, number] {
  return (x, z, height) => {
    /**
     * Jitter, so a band edge is ragged rather than a perfect contour drawn
     * around the hill — and scaled by the height it is jittering, because a
     * fixed ±20 m is nothing on a snow line and catastrophic on the Thames
     * floodplain, where it would scatter beaches across Islington.
     */
    const above = height + datum;
    const spread = Math.min(45, 1.5 + Math.max(0, above) * 0.03);
    const h = above + (valueNoise(x * 0.02, z * 0.02) - 0.5) * spread;

    if (h < 3) {
      return mix(SAND, GRASS, (h + 2) / 5);
    }
    if (h < 350) {
      return mix(GRASS, GRASS_DARK, (h - 3) / 347);
    }
    if (h < 950) {
      return mix(GRASS_DARK, ROCK, (h - 350) / 600);
    }
    return mix(ROCK, SNOW, (h - 1150) / 450);
  };
}

/**
 * Cells asked for while walking, so a miss costs one request rather than one
 * per sample per frame.
 */
const requested = new Set<string>();

function warmNeighbour(lon: number, lat: number): void {
  const cell = cellFor(lon, lat);
  const key = `${cell.col}:${cell.row}`;
  if (requested.has(key)) {
    return;
  }
  requested.add(key);
  void warmCell(cell);
}

function buildField(origin: { lon: number; lat: number }, datum: number): HeightField {
  // The cell the door opens into, resolved once: it answers all but the very
  // longest walks, and holding it here saves a map lookup per sample.
  const home = residentCell(origin.lon, origin.lat);

  return (x: number, z: number): number => {
    const { lon, lat } = toLonLat(origin, x, z);

    let metres =
      home != null &&
      lon >= home.bounds.west &&
      lon <= home.bounds.east &&
      lat >= home.bounds.south &&
      lat <= home.bounds.north
        ? sampleGrid(home, lon, lat)
        : heightAtLoaded(lon, lat);

    if (Number.isNaN(metres)) {
      // Either water, or a neighbouring cell nobody has needed until now. The
      // first is the answer; the second starts a download and reads as water
      // until it lands, which is why walking off the edge of a cell shows sea
      // for a moment rather than a hole.
      if (!cellIsAbsent(lon, lat) && residentCell(lon, lat) == null) {
        warmNeighbour(lon, lat);
      }
      return SEA_FLOOR - datum;
    }

    metres += detail(x, z, metres);
    return metres - datum;
  };
}

/**
 * The spawn's own elevation, and a nudge inland if the anchor turns out to be
 * water.
 *
 * Deterministic on purpose — every client runs the same search over the same
 * bytes and lands on the same origin, or the rooms would not agree about where
 * anything built in them is.
 */
function settleOrigin(): { origin: { lon: number; lat: number }; datum: number } {
  const here = heightAtLoaded(ANCHOR.lon, ANCHOR.lat);
  if (!Number.isNaN(here)) {
    return { origin: ANCHOR, datum: here };
  }

  // A ring search outwards in 100 m steps to 3 km, in a fixed order. GLO
  // records water as a void, so an anchor that lands in the Thames — or in a
  // reservoir, or a dock — is the one failure worth recovering from rather
  // than opening the door onto the river bed.
  for (let radius = 100; radius <= 3000; radius += 100) {
    for (let step = 0; step < 16; step++) {
      const angle = (step / 16) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const { lon, lat } = toLonLat(ANCHOR, x, z);
      const height = heightAtLoaded(lon, lat);
      if (!Number.isNaN(height)) {
        return { origin: { lon, lat }, datum: height };
      }
    }
  }

  // Nothing but sea within 3 km of the anchor. Somebody has moved it out over
  // open water, and the room would open onto a flat grey plane — which is far
  // harder to understand from inside the game than a message at the door.
  throw new Error(
    `there is no land within 3 km of ${ANCHOR.lat}, ${ANCHOR.lon} — the anchor is at sea`,
  );
}

let loading: Promise<GeoTerrain> | null = null;

/**
 * Load the terrain behind the door, once per session.
 *
 * Awaited before the world is entered rather than while it is being walked: a
 * player standing on ground that is still downloading is a player standing at
 * the wrong height, and in a shared world that is visible to everyone else.
 */
export function loadGeoTerrain(): Promise<GeoTerrain> {
  if (loading == null) {
    loading = (async () => {
      const home = await warmCell(cellFor(ANCHOR.lon, ANCHOR.lat));
      if (home == null) {
        // The one cell this world cannot do without. Usually permissions —
        // the app has to be allowed to read the Elevation dataset — so the
        // reason is carried out to the door rather than swallowed.
        throw new Error(
          cellFailure(ANCHOR.lon, ANCHOR.lat) ?? "the DEM cell for the spawn point is missing",
        );
      }
      const { origin, datum } = settleOrigin();
      return {
        height: buildField(origin, datum),
        color: geoColor(datum),
        datum,
        origin,
      };
    })().catch((err: unknown) => {
      // Not remembered: a failed load is worth retrying when the player shoots
      // the door again, whereas a cached rejection would make the door dead
      // for the rest of the session.
      loading = null;
      throw err;
    });
  }
  return loading;
}
