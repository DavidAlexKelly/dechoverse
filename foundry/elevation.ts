/**
 * Real elevation, read out of Foundry.
 *
 * The "Elevation" dataset in Offline World holds the Copernicus GLO-90 DEM cut
 * into one GeoTIFF per 2° cell, named c{col}_r{row}.tif on a grid whose origin
 * is (-180, 85) — the same cut as the chunked PMTiles basemap, the contours and
 * the pathfinding graphs, so a cell means the same square in all of them.
 *
 * WHY A CELL IS BIG ENOUGH TO IGNORE
 * ----------------------------------
 * A 2° cell is about 220 km on a side and 2400 x 2400 samples: one download of
 * a few megabytes covers more ground than anyone will walk in a session, so
 * this is a single load at the door rather than terrain streaming. Neighbours
 * are only ever needed if someone crosses a cell edge, which at walking speed
 * takes about twelve hours, so it is handled lazily and never awaited.
 *
 * WHY THE READ IS SPLIT IN TWO
 * ----------------------------
 * Fetching and decoding are async; the game's footing is not. Collision probes
 * the ground a couple of hundred times a frame and cannot await anything, so
 * the two halves are separate: `warmCell` puts a decoded cell in memory, and
 * `heightAtLoaded` reads from what is already there and never blocks.
 */
import { Datasets } from "@osdk/foundry";
import { fromArrayBuffer } from "geotiff";
import client from "@/foundry/client";
import { describeError } from "@/foundry/errors";

/** "Elevation" in /Accenture/[DK] Project Space/Offline World. */
export const ELEVATION_DATASET_RID = "ri.foundry.main.dataset.358e2e32-614c-4489-81e3-5dbd4d2d838c";

const BRANCH = "master";

/** The cut the chunks were made on. Shared with the basemap and the contours. */
export const DEM_GRID = { originLon: -180, originLat: 85, cellDeg: 2 };

/**
 * GLO's void sentinel, used when a chunk does not carry GDAL_NODATA.
 *
 * Ocean and many lakes are voids in GLO. Left unflagged, a -32768 interpolated
 * into a coastal sample is a canyon 32 km deep — so it is declared here rather
 * than trusted to be in the file.
 */
const FALLBACK_NODATA = -32768;

/** Cells held decoded. Each is 11-23 MB, so this is deliberately small. */
const RESIDENT_LIMIT = 3;

export interface CellCoord {
  col: number;
  row: number;
}

export interface HeightGrid {
  width: number;
  height: number;
  /** Row-major from the north-west corner. */
  values: Int16Array | Float32Array;
  bounds: { west: number; south: number; east: number; north: number };
  /** The value meaning "nothing measured here". */
  nodata: number;
}

export function cellKey(col: number, row: number): string {
  return `c${String(col).padStart(3, "0")}_r${String(row).padStart(3, "0")}`;
}

export function cellFor(lon: number, lat: number): CellCoord {
  return {
    col: Math.floor((lon - DEM_GRID.originLon) / DEM_GRID.cellDeg),
    row: Math.floor((DEM_GRID.originLat - lat) / DEM_GRID.cellDeg),
  };
}

export function cellBounds(col: number, row: number): HeightGrid["bounds"] {
  const west = DEM_GRID.originLon + col * DEM_GRID.cellDeg;
  const north = DEM_GRID.originLat - row * DEM_GRID.cellDeg;
  return { west, east: west + DEM_GRID.cellDeg, north, south: north - DEM_GRID.cellDeg };
}

const resident = new Map<string, HeightGrid>();
const pending = new Map<string, Promise<HeightGrid | null>>();
/**
 * Cells that could not be read, and why.
 *
 * Remembered rather than retried: a chunk that is missing or that this reader
 * cannot decode will not become readable a second later, and the caller asks
 * again on every frame. The reason is kept because the two causes need
 * different answers — most of the planet is ocean and has no chunk at all,
 * which is a normal answer, while a permissions failure is worth putting in
 * front of the player.
 */
const absent = new Map<string, string>();

function admit(key: string, grid: HeightGrid): void {
  resident.delete(key);
  resident.set(key, grid);
  while (resident.size > RESIDENT_LIMIT) {
    const oldest = resident.keys().next();
    if (oldest.done) {
      break;
    }
    resident.delete(oldest.value);
  }
}

async function decode(buffer: ArrayBuffer, cell: CellCoord): Promise<HeightGrid> {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const rasters = await image.readRasters({ interleave: false });
  const values = (rasters as unknown as Array<Int16Array | Float32Array>)[0];

  if (values == null) {
    throw new Error("no raster band");
  }

  const width = image.getWidth();
  const height = image.getHeight();
  if (width < 2 || height < 2) {
    throw new Error(`decoded ${width}x${height}, which cannot be interpolated`);
  }

  /**
   * The chunk's own extent when it declares one, the grid's otherwise.
   *
   * They should be identical — the chunks are named after the grid cell they
   * cover — and the chunk wins where they disagree, because a cut regenerated
   * on a different origin would otherwise offset every sample by up to two
   * degrees and look like slightly wrong terrain rather than an error.
   */
  let bounds = cellBounds(cell.col, cell.row);
  try {
    const [west, south, east, north] = image.getBoundingBox();
    if (Number.isFinite(west) && east > west && north > south) {
      bounds = { west, south, east, north };
    }
  } catch {
    /* no geo keys; the grid says where the cell is anyway */
  }

  return {
    width,
    height,
    values,
    bounds,
    nodata: image.getGDALNoData() ?? FALLBACK_NODATA,
  };
}

/**
 * Download and decode one cell, once.
 *
 * Resolves null when the cell has no chunk — open ocean, mostly — which is a
 * normal answer and not a failure.
 */
export function warmCell(cell: CellCoord): Promise<HeightGrid | null> {
  const key = cellKey(cell.col, cell.row);

  const cached = resident.get(key);
  if (cached != null) {
    return Promise.resolve(cached);
  }
  if (absent.has(key)) {
    return Promise.resolve(null);
  }

  const inFlight = pending.get(key);
  if (inFlight != null) {
    return inFlight;
  }

  const promise = (async () => {
    const path = `${key}.tif`;
    try {
      const response = await Datasets.Files.content(client, ELEVATION_DATASET_RID, path, {
        branchName: BRANCH,
      });
      const grid = await decode(await response.arrayBuffer(), cell);
      admit(key, grid);
      return grid;
    } catch (err) {
      absent.set(key, describeError(err));
      return null;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, promise);
  return promise;
}

/** The decoded cell covering a point, if it is already in memory. */
export function residentCell(lon: number, lat: number): HeightGrid | undefined {
  const cell = cellFor(lon, lat);
  return resident.get(cellKey(cell.col, cell.row));
}

/** True when the cell covering a point has already been tried and refused. */
export function cellIsAbsent(lon: number, lat: number): boolean {
  const cell = cellFor(lon, lat);
  return absent.has(cellKey(cell.col, cell.row));
}

/**
 * Why the cell covering a point could not be read, if it could not.
 *
 * The caller decides what that means: over the ocean there is simply no chunk
 * and the answer is water, but the cell the player is standing in failing is
 * something to put on screen.
 */
export function cellFailure(lon: number, lat: number): string | undefined {
  const cell = cellFor(lon, lat);
  return absent.get(cellKey(cell.col, cell.row));
}

function isData(grid: HeightGrid, value: number): boolean {
  return Number.isFinite(value) && value !== grid.nodata;
}

/**
 * Bilinear height in metres above sea level. NaN off the grid, and NaN where
 * every neighbour is a void.
 *
 * VOIDS ARE WEIGHTED OUT, NOT AVERAGED IN. GLO's sea and many of its lakes are
 * voids, and interpolating the sentinel into a coastal sample would put a
 * kilometres-deep gash along every shoreline. Dropping the void corners and
 * renormalising leaves the coast reading the height of the land beside it.
 *
 * Pixel-is-area, GDAL's default: sample centres sit half a step in from the
 * cell edges.
 */
export function sampleGrid(grid: HeightGrid, lon: number, lat: number): number {
  const dLon = (grid.bounds.east - grid.bounds.west) / grid.width;
  const dLat = (grid.bounds.north - grid.bounds.south) / grid.height;

  const fx = (lon - grid.bounds.west) / dLon - 0.5;
  const fy = (grid.bounds.north - lat) / dLat - 0.5;

  if (fx < -0.5 || fy < -0.5 || fx > grid.width - 0.5 || fy > grid.height - 0.5) {
    return NaN;
  }

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;

  const clampX = (x: number): number => Math.min(grid.width - 1, Math.max(0, x));
  const clampY = (y: number): number => Math.min(grid.height - 1, Math.max(0, y));

  const at = (col: number, row: number): number => grid.values[row * grid.width + col];

  const corners: Array<[number, number]> = [
    [at(clampX(x0), clampY(y0)), (1 - tx) * (1 - ty)],
    [at(clampX(x0 + 1), clampY(y0)), tx * (1 - ty)],
    [at(clampX(x0), clampY(y0 + 1)), (1 - tx) * ty],
    [at(clampX(x0 + 1), clampY(y0 + 1)), tx * ty],
  ];

  let sum = 0;
  let weight = 0;
  for (const [value, share] of corners) {
    if (share === 0 || !isData(grid, value)) {
      continue;
    }
    sum += value * share;
    weight += share;
  }

  return weight > 0 ? sum / weight : NaN;
}

/**
 * Height at a point from cells already in memory. NaN over water, over a void,
 * and — the case callers must not confuse with water — over a cell that has
 * not been loaded. Never blocks, so the collision sweep can call it.
 */
export function heightAtLoaded(lon: number, lat: number): number {
  const grid = residentCell(lon, lat);
  return grid ? sampleGrid(grid, lon, lat) : NaN;
}
