/**
 * What is on the ground in DechoWorld 2, out of the baked city chunks.
 *
 * The DEM says how high the ground is; it says nothing about what is on it.
 * [DK] City Chunks is the other half — real buildings, real streets and real
 * water, in real coordinates, which is exactly what is needed to lay
 * something on ground that is already in the right place.
 *
 * THIS FILE USED TO DECODE VECTOR TILES, AND USED TO INVENT THE CITY
 * ------------------------------------------------------------------
 * It read the chunked PMTiles basemap in the browser, at the zoom the
 * basemap's manifest declares. That is z10, and Protomaps keeps its buildings
 * at z13 and above — so the buildings layer was empty, the roads layer had
 * only motorways and A roads, and what stood up in Shoreditch was a
 * procedural terrace: `raiseBuildings` hashed a landuse cell's indices into a
 * box of hashed height and hashed brick colour. A tasteful fake, but a fake,
 * and it cost a tens-of-megabyte archive download to produce.
 *
 * The archives held z12 all along. The extraction now happens in a transform,
 * and what arrives here is geometry. Everything below is about placing it:
 * the vocabulary of kinds, the widths, the palettes and the patch lattice are
 * all as they were, because those were never the part that was wrong.
 *
 * WHAT z12 GIVES, AND WHAT IT STILL DOES NOT
 * ------------------------------------------
 *   ROADS: the whole network the schema has at that zoom — motorways down to
 *   minor and residential streets. Not merely the arterials.
 *
 *   BUILDINGS: real footprints, but MERGED ones. Protomaps only splits
 *   buildings into individual OSM features at z15, so a terrace arrives as
 *   one polygon covering the terrace rather than as eight houses. Heights are
 *   carried where OSM has them, which in London is a minority, so the rest
 *   are still inferred from the landuse underneath — the one piece of the old
 *   invention worth keeping, now attached to a real outline.
 */
import {
  type CityFeature,
  type CityTile,
  loadCityManifest,
  loadCityTile,
  tilesAround,
  vertexAt,
  vertexCount,
} from "@/foundry/cityChunks";
import { type LonLat, type Point2, clipPolylineToBox, fromLonLat } from "@/shared/geo";

/**
 * How much ground around the spawn is worth drawing.
 *
 * The fog closes at 500 m and the loaded world ends at 700, so these are
 * already generous. They are not free: everything inside them is decoded,
 * projected and turned into geometry at the moment the player arrives.
 */
export const ROADS_RADIUS_M = 1000;

/** Cover is area rather than line, so it is gathered closer in still. */
export const PATCHES_RADIUS_M = 800;

/** Buildings are the heaviest thing here, and the first to be missed up close. */
export const BUILDINGS_RADIUS_M = 900;

/**
 * Centreline spacing after resampling a road.
 *
 * Finer than the terrain mesh's 2.67 m vertices on purpose: the ribbon is
 * draped by sampling the ground at its own vertices, so anything coarser than
 * the terrain would let a crest between two road vertices poke up through the
 * tarmac.
 */
const STEP_M = 2.5;

/**
 * Side of one patch cell, in metres.
 *
 * PATCHES ARE RASTERISED RATHER THAN TRIANGULATED, and this is the reason the
 * result looks right. A city block triangulated from its outline is a handful
 * of enormous triangles: drape those at their corners only and the ground
 * rises straight through the middle of the block wherever the land is not
 * flat. On a fixed grid every cell is small enough to sit on the ground it
 * covers, and because the grid is global rather than per-polygon,
 * neighbouring cells share their corners exactly and the surface has no
 * cracks in it.
 *
 * Buildings are NOT rasterised this way — they have real outlines now, and a
 * building is small enough to sit on its own ground without help.
 */
const PATCH_CELL_M = 16;

/** Backstop against a radius someone raises without reading the arithmetic. */
const MAX_PATCH_CELLS = 12000;

/** Above this the collision sweep and the geometry stop being free. */
const MAX_BUILDINGS = 6000;

/** Nobody spawns inside a wall. Metres of clear ground around the origin. */
const SPAWN_CLEARANCE_M = 14;

/** Storeys are about this tall, so heights come out as floors stacked up. */
const STOREY_M = 3.2;

export interface RoadLine {
  /** Centreline in game metres. */
  points: Point2[];
  /** Full width in metres. */
  width: number;
  color: [number, number, number];
}

export interface PatchCell {
  /** Cell indices on the global patch lattice; multiply by PATCH_CELL_M. */
  cx: number;
  cz: number;
  color: [number, number, number];
}

export interface Building {
  /** Centre of the footprint, in game metres. */
  x: number;
  z: number;
  /**
   * Half extents of the box the footprint fits inside.
   *
   * Collision still uses this rather than the outline: the sweep tests a few
   * hundred boxes a frame and a polygon test per building would be felt. A
   * box round a merged block is close enough that you cannot walk into the
   * gap, which is the only thing it is for.
   */
  halfX: number;
  halfZ: number;
  height: number;
  color: [number, number, number];
  /** The real outline, in game metres. This is what gets drawn. */
  footprint: Point2[];
}

export interface WaterArea {
  /** An outline for a body of water; a centreline for a watercourse. */
  points: Point2[];
  line: boolean;
  /** Full width in metres. Only meaningful for a line. */
  width: number;
  color: [number, number, number];
}

export interface Surface {
  roads: RoadLine[];
  patches: PatchCell[];
  buildings: Building[];
  water: WaterArea[];
  /** Side of a patch cell, so the renderer does not have to import it. */
  patchCellSize: number;
}

/** A patch cell while it is being decided, before it becomes a PatchCell. */
interface CellClaim {
  cx: number;
  cz: number;
  priority: number;
  kind: string;
}

const EMPTY: Surface = {
  roads: [],
  patches: [],
  buildings: [],
  water: [],
  patchCellSize: PATCH_CELL_M,
};

/**
 * Width and colour per road kind.
 *
 * Widths are honest rather than cartographic: a motorway really is about 24 m
 * across including both carriageways, and drawing it at map-legend width
 * would make the M25 a footpath you could step over.
 */
const ROAD_STYLES: Record<string, { width: number; color: [number, number, number] }> = {
  highway: { width: 24, color: [0.72, 0.72, 0.74] },
  major_road: { width: 14, color: [0.68, 0.67, 0.68] },
  medium_road: { width: 9, color: [0.63, 0.62, 0.63] },
  minor_road: { width: 6, color: [0.58, 0.57, 0.58] },
  other: { width: 5, color: [0.55, 0.54, 0.55] },
  path: { width: 2, color: [0.6, 0.53, 0.43] },
  rail: { width: 3.5, color: [0.4, 0.37, 0.35] },
  aeroway: { width: 30, color: [0.45, 0.45, 0.47] },
  runway: { width: 45, color: [0.45, 0.45, 0.47] },
  taxiway: { width: 18, color: [0.48, 0.48, 0.5] },
  pier: { width: 4, color: [0.56, 0.5, 0.44] },
  ferry: { width: 0, color: [0, 0, 0] },
};

/**
 * Narrower than its class where OSM is specific about it.
 *
 * `kind` is a handful of buckets and a residential street is in the same one
 * as a B road. This is only consulted when the detail is named here, so an
 * unfamiliar value falls back to the bucket rather than to a default width.
 */
const ROAD_DETAIL_WIDTH: Record<string, number> = {
  motorway: 24,
  trunk: 18,
  primary: 15,
  secondary: 12,
  tertiary: 10,
  residential: 7,
  unclassified: 6,
  living_street: 5.5,
  service: 4,
  pedestrian: 5,
  footway: 2,
  cycleway: 2.5,
  track: 3,
  steps: 1.5,
};

const DEFAULT_ROAD = ROAD_STYLES.other;

/**
 * Ground cover, by the `kind` the tiles carry.
 *
 * `priority` settles overlaps — a park inside a residential district, a
 * school inside a park — because a cell belongs to exactly one of them.
 * Higher wins, and the order is smallest-and-most-specific first, so the park
 * does not disappear under the district it sits in.
 */
const PATCH_STYLES: Record<string, { color: [number, number, number]; priority: number }> = {
  residential: { color: [0.56, 0.53, 0.51], priority: 10 },
  neighbourhood: { color: [0.56, 0.53, 0.51], priority: 10 },
  suburb: { color: [0.56, 0.53, 0.51], priority: 10 },
  commercial: { color: [0.59, 0.54, 0.5], priority: 20 },
  retail: { color: [0.62, 0.55, 0.5], priority: 20 },
  industrial: { color: [0.5, 0.49, 0.51], priority: 20 },
  railway: { color: [0.46, 0.44, 0.45], priority: 25 },
  parking: { color: [0.6, 0.59, 0.58], priority: 35 },
  landfill: { color: [0.5, 0.46, 0.4], priority: 30 },
  port: { color: [0.52, 0.51, 0.52], priority: 30 },
  pier: { color: [0.56, 0.5, 0.44], priority: 45 },
  pedestrian: { color: [0.66, 0.63, 0.6], priority: 30 },
  hospital: { color: [0.68, 0.56, 0.56], priority: 40 },
  school: { color: [0.64, 0.58, 0.5], priority: 40 },
  university: { color: [0.64, 0.58, 0.5], priority: 40 },
  college: { color: [0.64, 0.58, 0.5], priority: 40 },
  military: { color: [0.5, 0.5, 0.42], priority: 40 },
  aerodrome: { color: [0.6, 0.6, 0.62], priority: 40 },
  runway: { color: [0.45, 0.45, 0.47], priority: 50 },
  quarry: { color: [0.62, 0.58, 0.5], priority: 40 },

  // Green, because built-up only reads as built-up next to something that is
  // not. These are the same palette the terrain uses, a shade apart.
  park: { color: [0.4, 0.62, 0.34], priority: 60 },
  garden: { color: [0.4, 0.62, 0.34], priority: 60 },
  grass: { color: [0.42, 0.63, 0.35], priority: 55 },
  pitch: { color: [0.38, 0.6, 0.33], priority: 65 },
  playground: { color: [0.5, 0.6, 0.4], priority: 65 },
  recreation_ground: { color: [0.42, 0.62, 0.35], priority: 55 },
  village_green: { color: [0.44, 0.64, 0.36], priority: 60 },
  stadium: { color: [0.52, 0.56, 0.46], priority: 70 },
  wetland: { color: [0.42, 0.55, 0.42], priority: 45 },
  farmyard: { color: [0.6, 0.56, 0.42], priority: 45 },
  golf_course: { color: [0.4, 0.62, 0.34], priority: 55 },
  cemetery: { color: [0.38, 0.55, 0.35], priority: 60 },
  forest: { color: [0.24, 0.44, 0.23], priority: 50 },
  wood: { color: [0.24, 0.44, 0.23], priority: 50 },
  scrub: { color: [0.36, 0.5, 0.3], priority: 45 },
  meadow: { color: [0.45, 0.62, 0.36], priority: 45 },
  farmland: { color: [0.62, 0.62, 0.38], priority: 40 },
  allotments: { color: [0.55, 0.58, 0.36], priority: 50 },
  orchard: { color: [0.4, 0.57, 0.32], priority: 50 },
  nature_reserve: { color: [0.3, 0.5, 0.28], priority: 35 },
  national_park: { color: [0.3, 0.5, 0.28], priority: 35 },
  beach: { color: [0.85, 0.78, 0.55], priority: 60 },
  zoo: { color: [0.45, 0.58, 0.35], priority: 50 },
};

/**
 * Water, by what the bake found in `kind_detail`.
 *
 * Widths are for the ones that arrive as lines. A river drawn as a line is a
 * river too narrow to have been given banks, so these are deliberately modest
 * — the Thames through London is a polygon and takes its own shape.
 */
const WATER_STYLES: Record<string, { width: number; color: [number, number, number] }> = {
  water: { width: 8, color: [0.18, 0.42, 0.6] },
  river: { width: 22, color: [0.18, 0.42, 0.6] },
  riverbank: { width: 22, color: [0.18, 0.42, 0.6] },
  canal: { width: 10, color: [0.2, 0.44, 0.58] },
  stream: { width: 3.5, color: [0.22, 0.46, 0.58] },
  ditch: { width: 2, color: [0.24, 0.44, 0.52] },
  drain: { width: 2, color: [0.24, 0.44, 0.52] },
  lake: { width: 0, color: [0.16, 0.4, 0.6] },
  pond: { width: 0, color: [0.16, 0.4, 0.6] },
  reservoir: { width: 0, color: [0.14, 0.38, 0.58] },
  basin: { width: 0, color: [0.16, 0.4, 0.56] },
  dock: { width: 0, color: [0.15, 0.36, 0.5] },
  swimming_pool: { width: 0, color: [0.28, 0.62, 0.74] },
};

const DEFAULT_WATER = WATER_STYLES.water;

/**
 * What stands on each kind of ground, for buildings OSM gave no height.
 *
 * The footprint is real; only the height and the colour are guessed, and they
 * are guessed from what the block is for. Heights are in metres and are the
 * range for the kind, not for any particular street.
 */
const BUILDING_KINDS: Record<
  string,
  { minHeight: number; maxHeight: number; palette: [number, number, number][] }
> = {
  residential: {
    minHeight: 7,
    maxHeight: 14,
    palette: [
      // London brick, three shades of it, and a stuccoed terrace.
      [0.55, 0.38, 0.31],
      [0.47, 0.33, 0.28],
      [0.62, 0.45, 0.36],
      [0.78, 0.75, 0.7],
    ],
  },
  commercial: {
    minHeight: 14,
    maxHeight: 46,
    palette: [
      [0.5, 0.53, 0.58],
      [0.42, 0.46, 0.52],
      [0.6, 0.62, 0.65],
      [0.35, 0.4, 0.46],
    ],
  },
  retail: {
    minHeight: 7,
    maxHeight: 16,
    palette: [
      [0.6, 0.5, 0.44],
      [0.66, 0.6, 0.52],
      [0.52, 0.48, 0.46],
    ],
  },
  industrial: {
    minHeight: 6,
    maxHeight: 15,
    palette: [
      [0.52, 0.52, 0.54],
      [0.46, 0.47, 0.5],
      [0.58, 0.56, 0.52],
    ],
  },
  hospital: {
    minHeight: 12,
    maxHeight: 28,
    palette: [
      [0.72, 0.7, 0.7],
      [0.66, 0.64, 0.66],
    ],
  },
  school: {
    minHeight: 8,
    maxHeight: 16,
    palette: [
      [0.64, 0.56, 0.48],
      [0.7, 0.66, 0.6],
    ],
  },
};

/** Anywhere the landuse does not say, or does not say anything useful. */
const DEFAULT_BUILDING = {
  minHeight: 8,
  maxHeight: 20,
  palette: [
    [0.62, 0.55, 0.48],
    [0.55, 0.5, 0.46],
    [0.68, 0.62, 0.54],
  ] as [number, number, number][],
};

/** Landuse kinds that share a building palette with a near neighbour. */
const BUILDING_KIND_ALIASES: Record<string, string> = {
  neighbourhood: "residential",
  suburb: "residential",
  university: "school",
  college: "school",
};

/**
 * Deterministic hash of a position and a purpose, in 0..1.
 *
 * No Math.random anywhere near this: every client builds the city from the
 * same tiles and must arrive at the same city, or players would be standing
 * inside each other's walls. The footprints are now real, so this decides
 * only colour and the height of a building OSM did not measure — but those
 * still have to agree, or the same block is a different colour to everyone.
 *
 * Keyed on decimetres of position rather than on anything about the order
 * features arrived in, so a tile that loads second is not a different city.
 */
function hash(x: number, z: number, salt: number): number {
  let h =
    Math.imul(Math.round(x * 10), 0x27d4eb2d) ^
    Math.imul(Math.round(z * 10), 0x165667b1) ^
    Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** One feature's vertices, projected into game metres about the origin. */
function toGame(tile: CityTile, feature: CityFeature, origin: LonLat): Point2[] {
  const count = vertexCount(feature);
  const points: Point2[] = new Array(count);
  for (let index = 0; index < count; index++) {
    const { lon, lat } = vertexAt(tile, feature, index);
    points[index] = fromLonLat(origin, lon, lat);
  }
  return points;
}

/**
 * Everything the bake knows about the ground around the origin.
 *
 * Cosmetic, and treated as such by its caller: a tile that fails to load
 * costs a street rather than the world, so every failure below resolves to
 * less city rather than to an error.
 */
export async function loadSurface(origin: LonLat): Promise<Surface> {
  const manifest = await loadCityManifest();
  if (manifest == null) {
    return EMPTY;
  }

  const radius = Math.max(ROADS_RADIUS_M, PATCHES_RADIUS_M, BUILDINGS_RADIUS_M);
  const keys = tilesAround(origin, radius, manifest.grid);
  const tiles = (await Promise.all(keys.map((key) => loadCityTile(key, manifest)))).filter(
    (tile): tile is CityTile => tile != null,
  );

  const roads: RoadLine[] = [];
  const water: WaterArea[] = [];
  /** One style per cell, highest priority wins. See PATCH_STYLES. */
  const cells = new Map<string, CellClaim>();

  for (const tile of tiles) {
    for (const feature of tile.roads) {
      collectRoad(tile, feature, origin, roads);
    }
    for (const feature of tile.water) {
      collectWater(tile, feature, origin, water);
    }
    // Landuse before buildings: what a block is for decides what colour the
    // buildings on it are and how tall the unmeasured ones stand.
    for (const feature of tile.landuse) {
      collectPatch(tile, feature, origin, cells);
    }
  }

  const patches: PatchCell[] = [];
  for (const cell of cells.values()) {
    patches.push({ cx: cell.cx, cz: cell.cz, color: PATCH_STYLES[cell.kind].color });
  }

  const buildings: Building[] = [];
  for (const tile of tiles) {
    for (const feature of tile.buildings) {
      collectBuilding(tile, feature, origin, cells, buildings);
    }
  }

  // Nearest first, so the cap keeps the buildings the player can actually see
  // rather than whichever tile happened to be decoded first.
  buildings.sort((a, b) => a.x * a.x + a.z * a.z - (b.x * b.x + b.z * b.z));

  return {
    roads,
    patches,
    buildings: buildings.slice(0, MAX_BUILDINGS),
    water,
    patchCellSize: PATCH_CELL_M,
  };
}

function roadStyle(feature: CityFeature): { width: number; color: [number, number, number] } {
  const style = (feature.kind != null ? ROAD_STYLES[feature.kind] : undefined) ?? DEFAULT_ROAD;
  const detailed = feature.detail != null ? ROAD_DETAIL_WIDTH[feature.detail] : undefined;
  return detailed == null ? style : { width: detailed, color: style.color };
}

function collectRoad(
  tile: CityTile,
  feature: CityFeature,
  origin: LonLat,
  into: RoadLine[],
): void {
  const style = roadStyle(feature);
  // A ferry route is a line across water, not a road. Zero width is how the
  // table says "carried in the data, not drawn".
  if (style.width <= 0) {
    return;
  }

  const points = toGame(tile, feature, origin);
  for (const run of clipPolylineToBox(points, ROADS_RADIUS_M)) {
    into.push({ points: resample(run, STEP_M), width: style.width, color: style.color });
  }
}

function collectWater(
  tile: CityTile,
  feature: CityFeature,
  origin: LonLat,
  into: WaterArea[],
): void {
  const style = (feature.kind != null ? WATER_STYLES[feature.kind] : undefined) ?? DEFAULT_WATER;
  const points = toGame(tile, feature, origin);

  if (feature.line === true) {
    for (const run of clipPolylineToBox(points, ROADS_RADIUS_M)) {
      into.push({
        points: resample(run, STEP_M),
        line: true,
        width: style.width,
        color: style.color,
      });
    }
    return;
  }

  // An area is kept whole or not at all — clipping a lake to a square would
  // put a straight edge across it with nothing on the other side.
  if (points.length >= 3 && nearestDistance(points) <= ROADS_RADIUS_M) {
    into.push({ points, line: false, width: 0, color: style.color });
  }
}

function collectPatch(
  tile: CityTile,
  feature: CityFeature,
  origin: LonLat,
  into: Map<string, CellClaim>,
): void {
  const kind = feature.kind;
  if (kind == null) {
    return;
  }
  const style = PATCH_STYLES[kind];
  if (style == null) {
    return;
  }
  rasterise(toGame(tile, feature, origin), kind, style.priority, into);
}

function collectBuilding(
  tile: CityTile,
  feature: CityFeature,
  origin: LonLat,
  cells: Map<string, CellClaim>,
  into: Building[],
): void {
  const footprint = toGame(tile, feature, origin);
  if (footprint.length < 3) {
    return;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of footprint) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }

  const x = (minX + maxX) / 2;
  const z = (minZ + maxZ) / 2;

  if (Math.hypot(x, z) > BUILDINGS_RADIUS_M) {
    return;
  }
  // The door opens onto this ground, and a merged block dropped on the spawn
  // is a player inside a wall before they have moved.
  if (Math.hypot(x, z) < SPAWN_CLEARANCE_M) {
    return;
  }

  const cell = cells.get(
    `${Math.floor(x / PATCH_CELL_M)}:${Math.floor(z / PATCH_CELL_M)}`,
  );
  const named = cell?.kind;
  const kindName = named == null ? null : (BUILDING_KIND_ALIASES[named] ?? named);
  const kind = (kindName != null ? BUILDING_KINDS[kindName] : undefined) ?? DEFAULT_BUILDING;

  // Measured where OSM measured it. Squared hash otherwise, so a district is
  // mostly its own low-rise with the occasional taller thing in it rather
  // than an even spread between the bounds.
  const declared = typeof feature.h === "number" && feature.h > 0 ? feature.h : null;
  const inferred =
    kind.minHeight + hash(x, z, 6) ** 2 * (kind.maxHeight - kind.minHeight);
  const height = Math.max(STOREY_M, declared ?? Math.round(inferred / STOREY_M) * STOREY_M);

  const palette = kind.palette;
  const color = palette[Math.floor(hash(x, z, 7) * palette.length) % palette.length];

  into.push({
    x,
    z,
    halfX: Math.max(0.5, (maxX - minX) / 2),
    halfZ: Math.max(0.5, (maxZ - minZ) / 2),
    height,
    color,
    footprint,
  });
}

/** Distance from the origin to the nearest vertex of a ring. */
function nearestDistance(points: Point2[]): number {
  let nearest = Infinity;
  for (const point of points) {
    nearest = Math.min(nearest, Math.hypot(point.x, point.z));
  }
  return nearest;
}

/**
 * Fill a polygon's cells on the global patch lattice.
 *
 * BY SCANLINE, NOT BY TESTING EVERY CELL. Point-in-polygon per cell is cells ×
 * edges, and a Greater London landuse polygon crossed with a 100 x 100 grid of
 * cells is tens of millions of comparisons for one feature — which is what
 * made entering the world lock up. A scanline crosses each row once, so the
 * cost is rows × edges: a hundred times less for the same answer.
 *
 * Even-odd against the ring, so a polygon that doubles back on itself still
 * fills the way it looks.
 */
function rasterise(
  ring: Point2[],
  kind: string,
  priority: number,
  into: Map<string, CellClaim>,
): void {
  const limit = PATCHES_RADIUS_M / PATCH_CELL_M;

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of ring) {
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  if (!Number.isFinite(minZ)) {
    return;
  }

  const firstZ = Math.max(-limit, Math.floor(minZ / PATCH_CELL_M));
  const lastZ = Math.min(limit, Math.floor(maxZ / PATCH_CELL_M));

  const crossings: number[] = [];

  for (let cz = firstZ; cz <= lastZ; cz++) {
    const z = (cz + 0.5) * PATCH_CELL_M;

    crossings.length = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.z > z !== b.z > z) {
        crossings.push(a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x));
      }
    }
    if (crossings.length < 2) {
      continue;
    }
    crossings.sort((left, right) => left - right);

    for (let span = 0; span + 1 < crossings.length; span += 2) {
      // Cells whose CENTRE falls in the span, which is what keeps the lattice
      // global: the same cell is filled from whichever polygon covers it.
      const from = Math.max(-limit, Math.ceil(crossings[span] / PATCH_CELL_M - 0.5));
      const to = Math.min(limit, Math.floor(crossings[span + 1] / PATCH_CELL_M - 0.5));

      for (let cx = from; cx <= to; cx++) {
        if (into.size >= MAX_PATCH_CELLS) {
          return;
        }
        const key = `${cx}:${cz}`;
        const held = into.get(key);
        if (held == null || held.priority < priority) {
          into.set(key, { cx, cz, priority, kind });
        }
      }
    }
  }
}

/**
 * Split long segments so a road can follow the ground.
 *
 * Tile geometry is generalised for a flat map, where a straight kilometre is
 * two points. Laid on terrain, those two points would cut through every rise
 * between them.
 */
function resample(points: Point2[], step: number): Point2[] {
  const out: Point2[] = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const span = Math.hypot(to.x - from.x, to.z - from.z);
    const pieces = Math.max(1, Math.ceil(span / step));
    for (let piece = 1; piece <= pieces; piece++) {
      const t = piece / pieces;
      out.push({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t });
    }
  }

  return out;
}
