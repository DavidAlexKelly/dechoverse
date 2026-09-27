/**
 * The city, read out of Foundry a tile at a time.
 *
 * [DK] City Chunks holds what the basemap knows about the ground — buildings,
 * streets, water and landuse — already extracted, already clipped, already
 * simplified, as one small JSON per 0.04 degree tile.
 *
 * WHAT THIS REPLACED, AND WHY
 * ---------------------------
 * This used to be done in the browser. `basemapTiles.ts` fetched a per-cell
 * PMTiles archive — tens of megabytes, whole, because the platform client
 * cannot set a Range header — and `surface.ts` decoded vector tiles out of it
 * with three npm packages. Worse, it read the zoom the basemap's manifest
 * declares, which is z10, and Protomaps keeps its buildings at z13+. So the
 * expensive path returned no footprints at all and the city was invented from
 * landuse polygons.
 *
 * The archives turned out to hold z12. The extraction moved to a transform
 * (`city_chunks.py`), which reads each archive at the zoom it actually has,
 * and what arrives here is a few tens of kilobytes for the ground the player
 * can see. No tile decoder, no archive, no zoom to get wrong.
 *
 * TILES ARE CACHED IN THE BROWSER, KEYED ON THE BAKE
 * --------------------------------------------------
 * A tile never changes until the transform runs again, so the second visit
 * should not pay for it. The cache key carries the bake's `generatedAt`, and
 * everything under a different one is swept on load — because two players in
 * the same world have to agree about where the buildings are, and a cache
 * that outlived a re-bake is one player walking through another's city.
 */
import { Datasets } from "@osdk/foundry";
import client from "@/foundry/client";
import { openStore } from "@/shared/idbCache";

/** "[DK] City Chunks" in /Accenture/[DK] Project Space/Offline World. */
export const CITY_DATASET_RID = "ri.foundry.main.dataset.fdfb190e-01bc-4590-9cdc-356dff87e125";

const BRANCH = "master";
const MANIFEST_PATH = "manifest.json";

/** The tile format this reader understands. See city.py's FORMAT_VERSION. */
const SUPPORTED_VERSION = 1;

export function isCityEnabled(): boolean {
  // Deliberately not a comparison against "": pasting a RID over every empty
  // string in this file would otherwise rewrite the guard along with it.
  return CITY_DATASET_RID.startsWith("ri.foundry.main.dataset.");
}

/** One feature: some description, and a flat list of coordinate offsets. */
export interface CityFeature {
  /** Coarse road kind, water kind or landuse kind. */
  kind?: string;
  /** The OSM name behind `kind`, where the bake had one. */
  detail?: string;
  /** Height in metres, when OSM declared one. Absent means "infer it". */
  h?: number;
  /** Base height for a part that starts above the ground. */
  mh?: number;
  part?: boolean;
  bridge?: boolean;
  tunnel?: boolean;
  /** True for a watercourse drawn as a line rather than an area. */
  line?: boolean;
  /**
   * East, south, east, south … in units of the tile's `scale`, measured from
   * its north-west corner. South rather than north because the game's z runs
   * that way, so nothing here has to remember to flip a sign.
   */
  v: number[];
}

export interface CityTile {
  version: number;
  tile: string;
  origin: { lon: number; lat: number };
  scale: number;
  buildings: CityFeature[];
  roads: CityFeature[];
  water: CityFeature[];
  landuse: CityFeature[];
}

export interface CityGrid {
  originLon: number;
  originLat: number;
  cellDeg: number;
}

export interface CityManifest {
  version: number;
  generatedAt: number;
  grid: CityGrid;
  /** Tiles the bake actually wrote. Anything else is empty ground. */
  tiles: Set<string>;
}

/**
 * The tile containing a point.
 *
 * Arithmetically identical to `tile_for` in city.py, down to the order of
 * operations. 0.04 has no exact binary form, so a point on a tile boundary
 * lands on whichever side the rounding puts it — which is fine as long as
 * both ends of the pipeline round the same way, and is a file that silently
 * does not exist if they do not.
 */
export function tileFor(lon: number, lat: number, grid: CityGrid): { col: number; row: number } {
  return {
    col: Math.floor((lon - grid.originLon) / grid.cellDeg),
    row: Math.floor((grid.originLat - lat) / grid.cellDeg),
  };
}

/** Six digits each, matching `tile_key` in city.py. */
export function tileKey(col: number, row: number): string {
  return `x${String(col).padStart(6, "0")}_y${String(row).padStart(6, "0")}`;
}

async function readJson<T>(path: string): Promise<T> {
  const response = await Datasets.Files.content(client, CITY_DATASET_RID, path, {
    branchName: BRANCH,
  });
  return (await response.json()) as T;
}

const store = openStore("dechoworld", "city");

let manifestPromise: Promise<CityManifest | null> | null = null;

/**
 * The bake's manifest, once per session.
 *
 * Null when the dataset is switched off, missing, unreadable or of a version
 * this client does not know — all of which mean the same thing to the caller:
 * there is no city, draw the ground and carry on. The world is not made of
 * this, so none of it is worth an error on screen.
 */
export function loadCityManifest(): Promise<CityManifest | null> {
  if (manifestPromise == null) {
    manifestPromise = (async (): Promise<CityManifest | null> => {
      if (!isCityEnabled()) {
        return null;
      }
      try {
        const raw = await readJson<{
          version?: number;
          generatedAt?: number;
          grid?: CityGrid;
          tiles?: string[];
        }>(MANIFEST_PATH);

        if (raw.version !== SUPPORTED_VERSION || raw.grid == null) {
          return null;
        }

        const manifest: CityManifest = {
          version: raw.version,
          generatedAt: raw.generatedAt ?? 0,
          grid: raw.grid,
          tiles: new Set(raw.tiles ?? []),
        };

        // Anything from an earlier bake is dead weight and, read by accident,
        // would be a different city. Not awaited: it is housekeeping, and the
        // first tile should not wait behind it.
        void store.sweep(`${manifest.generatedAt}|`);
        return manifest;
      } catch {
        return null;
      }
    })().catch(() => null);
  }
  return manifestPromise;
}

/** Tiles decoded this session, so walking back over your own steps is free. */
const resident = new Map<string, Promise<CityTile | null>>();

/**
 * One tile: from memory, then from the browser's cache, then from Foundry.
 *
 * Null is an ordinary answer. Most of the world has no city in it, the bake
 * covers one cell so far, and a tile that was never written is simply empty
 * ground — none of which is a failure worth reporting.
 */
export function loadCityTile(key: string, manifest: CityManifest): Promise<CityTile | null> {
  const existing = resident.get(key);
  if (existing != null) {
    return existing;
  }

  const promise = (async (): Promise<CityTile | null> => {
    if (!manifest.tiles.has(key)) {
      return null;
    }

    const cacheKey = `${manifest.generatedAt}|${key}`;
    const cached = await store.get<CityTile>(cacheKey);
    if (cached != null && cached.version === SUPPORTED_VERSION) {
      return cached;
    }

    try {
      const tile = await readJson<CityTile>(`city/${key}.json`);
      if (tile.version !== SUPPORTED_VERSION) {
        return null;
      }
      // Not awaited: the caller wants the tile, not the bookkeeping, and a
      // write that fails is a cache miss next time rather than a problem now.
      void store.put(cacheKey, tile);
      return tile;
    } catch {
      return null;
    }
  })();

  resident.set(key, promise);
  return promise;
}

/**
 * Every tile touching a square of `radius` metres about a point.
 *
 * Degrees rather than a projection, because the tile grid is in degrees and
 * this only has to be generous — a tile too many costs a cache hit, a tile
 * too few costs a missing street.
 */
export function tilesAround(
  origin: { lon: number; lat: number },
  radiusM: number,
  grid: CityGrid,
): string[] {
  const latSpan = radiusM / 111320;
  const lonSpan = latSpan / Math.max(0.05, Math.cos((origin.lat * Math.PI) / 180));

  const northWest = tileFor(origin.lon - lonSpan, origin.lat + latSpan, grid);
  const southEast = tileFor(origin.lon + lonSpan, origin.lat - latSpan, grid);

  const keys: string[] = [];
  for (let col = northWest.col; col <= southEast.col; col++) {
    for (let row = northWest.row; row <= southEast.row; row++) {
      keys.push(tileKey(col, row));
    }
  }
  return keys;
}

/** The longitude and latitude of vertex `index` of a feature. */
export function vertexAt(
  tile: CityTile,
  feature: CityFeature,
  index: number,
): { lon: number; lat: number } {
  return {
    lon: tile.origin.lon + feature.v[index * 2] * tile.scale,
    lat: tile.origin.lat - feature.v[index * 2 + 1] * tile.scale,
  };
}

export function vertexCount(feature: CityFeature): number {
  return feature.v.length >> 1;
}
