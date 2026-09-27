/**
 * Vector tiles out of the chunked PMTiles basemap.
 *
 * "[MAP] Chunked PMtiles" in Offline World is a Protomaps basemap cut into one
 * archive per grid cell, described by a manifest at the root: a single archive
 * for z0-z6, then 6° grids for z7-z9 and for z10, which is as deep as the bake
 * goes. Each archive is an ordinary PMTiles file, so the `pmtiles` reader does
 * the index work; all this supplies is the bytes and the arithmetic for which
 * archive holds which tile.
 *
 * WHAT IS IN THESE TILES, AND WHAT IS NOT
 * ---------------------------------------
 * The Protomaps schema: `earth`, `water`, `landuse`, `roads`, `places` and the
 * rest, each feature carrying a `kind`. At z10 the roads layer is the arterial
 * network — motorways, trunk and A roads — and not the street grid, which the
 * schema only introduces around z12. There are no buildings at all: those start
 * at z13, three levels above where this bake stops. Nothing here can conjure
 * them; that is a re-bake, not a code change.
 */
import { PMTiles, type Source } from "pmtiles";
import { getFile, getJson, releaseFile } from "@/foundry/datasetBytes";
import { latAtTileY, lonAtTileX } from "@/shared/geo";

/** "[MAP] Chunked PMtiles" in /Accenture/[DK] Project Space/Offline World. */
export const BASEMAP_DATASET_RID = "ri.foundry.main.dataset.c7e99de1-90a4-4e22-bd26-b42316d70fe4";

const MANIFEST_PATH = "manifest.json";

interface ManifestCell {
  col: number;
  row: number;
  bytes?: number;
}

interface GridLayer {
  id?: string;
  type: "grid";
  minZoom: number;
  maxZoom: number;
  cellDeg: number;
  pathTemplate: string;
  cells?: Array<ManifestCell | [number, number]>;
}

interface SingleLayer {
  id?: string;
  type: "single";
  minZoom: number;
  maxZoom: number;
  path: string;
}

interface GlobeManifest {
  version?: number;
  gridOrigin: { lon: number; lat: number };
  layers: Array<GridLayer | SingleLayer>;
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/**
 * The manifest's path template, filled in.
 *
 * Two spellings are in use across these bakes — "{cell}" for the whole
 * c000_r000 name and "{col}"/"{row}" for the halves — and both appear in
 * datasets that are already deployed, so both are accepted.
 */
function fillTemplate(template: string, col: number, row: number): string {
  return template
    .replace("{cell}", `c${pad3(col)}_r${pad3(row)}`)
    .replace("{col}", pad3(col))
    .replace("{row}", pad3(row));
}

function normaliseCell(entry: ManifestCell | [number, number]): ManifestCell {
  return Array.isArray(entry) ? { col: entry[0], row: entry[1] } : entry;
}

export interface TileIndex {
  /** The deepest zoom the bake holds tiles for. */
  maxZoom: number;
  /** Archive paths that might hold this tile, best guess first. */
  pathsForTile(z: number, x: number, y: number): string[];
}

let indexPromise: Promise<TileIndex> | null = null;

/** Read the manifest once and work out where tiles live. */
export function loadTileIndex(): Promise<TileIndex> {
  if (indexPromise == null) {
    indexPromise = (async (): Promise<TileIndex> => {
      const manifest = await getJson<GlobeManifest>(BASEMAP_DATASET_RID, MANIFEST_PATH);
      const origin = manifest.gridOrigin;

      const grids = manifest.layers.filter((layer): layer is GridLayer => layer.type === "grid");
      const maxZoom = manifest.layers.reduce((best, layer) => Math.max(best, layer.maxZoom), 0);

      return {
        maxZoom,

        pathsForTile(z, x, y) {
          const layer = grids.find((grid) => z >= grid.minZoom && z <= grid.maxZoom);
          if (layer == null) {
            return [];
          }

          const declared =
            layer.cells != null
              ? new Set(
                  layer.cells.map((entry) => {
                    const cell = normaliseCell(entry);
                    return `${cell.col}:${cell.row}`;
                  }),
                )
              : null;

          /**
           * Which cell holds a tile is not quite a question of arithmetic.
           * Cells are 6° and z10 tiles are 0.3515625°, which do not divide, so
           * a tile can straddle a cell boundary and the bake had to pick one —
           * by the tile's centre, or its north-west corner, or something else.
           * Rather than depend on which, the centre is tried first and the
           * corners after: at most three candidates, all but one of them
           * usually the same cell, and no assumption to be wrong about.
           */
          const candidates: string[] = [];
          const seen = new Set<string>();

          const consider = (lon: number, lat: number): void => {
            const col = Math.floor((lon - origin.lon) / layer.cellDeg);
            const row = Math.floor((origin.lat - lat) / layer.cellDeg);
            const key = `${col}:${row}`;
            if (seen.has(key)) {
              return;
            }
            seen.add(key);
            if (declared != null && !declared.has(key)) {
              // The manifest lists every cell that exists — most of the planet
              // is sea and has no archive — so a cell it does not name is one
              // not worth a request.
              return;
            }
            candidates.push(fillTemplate(layer.pathTemplate, col, row));
          };

          const west = lonAtTileX(x, z);
          const east = lonAtTileX(x + 1, z);
          const north = latAtTileY(y, z);
          const south = latAtTileY(y + 1, z);

          consider((west + east) / 2, (north + south) / 2);
          consider(west, north);
          consider(east, north);
          consider(west, south);
          consider(east, south);

          return candidates;
        },
      };
    })().catch((err: unknown) => {
      indexPromise = null;
      throw err;
    });
  }
  return indexPromise;
}

// ── Archives ────────────────────────────────────────────────────────────────

/**
 * A PMTiles source over an archive held in memory.
 *
 * The reader asks for ranges — a header, a directory, a tile — and each one is
 * a slice of a buffer that was downloaded once. See datasetBytes for why the
 * whole archive comes down rather than the ranges going over the wire.
 */
class DatasetSource implements Source {
  constructor(private readonly path: string) {}

  getKey(): string {
    return `${BASEMAP_DATASET_RID}|${this.path}`;
  }

  async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
    const archive = await getFile(BASEMAP_DATASET_RID, this.path);
    return { data: archive.slice(offset, offset + length) };
  }
}

const archives = new Map<string, PMTiles>();
/** Archives that could not be opened, so one bad path costs one request. */
const unopenable = new Set<string>();

function archiveAt(path: string): PMTiles {
  let archive = archives.get(path);
  if (archive == null) {
    archive = new PMTiles(new DatasetSource(path));
    archives.set(path, archive);
  }
  return archive;
}

/**
 * Let go of every archive read so far.
 *
 * A basemap chunk is tens of megabytes, and a caller that reads what it needs
 * in one pass — the roads around a spawn point, say — has no use for it
 * afterwards. Holding it would cost more memory than the whole rest of the
 * scene put together. Anything asked for later simply fetches again.
 */
export function releaseArchives(): void {
  for (const path of archives.keys()) {
    releaseFile(BASEMAP_DATASET_RID, path);
  }
  archives.clear();
}

/**
 * The raw vector tile at z/x/y, or null where the bake has nothing.
 *
 * Null is an ordinary answer: the sea has no archive, and even inside one a
 * tile with no features in it was never written.
 */
export async function getTileBytes(z: number, x: number, y: number): Promise<ArrayBuffer | null> {
  const index = await loadTileIndex();
  for (const path of index.pathsForTile(z, x, y)) {
    if (unopenable.has(path)) {
      continue;
    }
    try {
      const tile = await archiveAt(path).getZxy(z, x, y);
      if (tile != null) {
        return tile.data;
      }
    } catch {
      // A missing or unreadable archive is not worth asking about again, and
      // the next candidate cell may well hold the tile.
      unopenable.add(path);
      archives.delete(path);
    }
  }
  return null;
}
