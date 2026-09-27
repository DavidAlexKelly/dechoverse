/**
 * Folding the mark stream into the things a room is made of.
 *
 * Pure functions over the folded record map, with no React and no stream
 * client, so the same fold serves two readers: useMarkSync, which draws the
 * room, and the AI players' WorldView, which has to see the same cubes and
 * craters the humans see or it would walk through walls they built. The fold
 * used to live inside the hook's useMemos, which only a component could call.
 */
import type { MarkRecord } from "@/foundry/streams/marks";
import { decodeDabs, decodePads } from "@/game/domain/codec";
import type {
  Crater,
  Cube,
  FlatPad,
  PaintBlob,
  PaintStroke,
  PlacedDoor,
  PlacedObject,
} from "@/game/domain/types";
import { isFurnitureKind } from "@/game/world/furnitureCatalog";
import { DEFAULT_CUBE_COLOR, DEFAULT_CUBE_OPACITY } from "@/game/world/voxels";

export type MarkMap = Map<string, MarkRecord>;

/**
 * Folds records into the map, newest timestamp per markId wins.
 *
 * Returns the same map when nothing changed, so a React state setter can bail
 * out of a render, and a new one otherwise — the input is never mutated.
 */
export function mergeMarks(previous: MarkMap, records: MarkRecord[]): MarkMap {
  let next: MarkMap | null = null;
  for (const record of records) {
    const existing = (next ?? previous).get(record.markId);
    if (existing != null) {
      if (existing.timestamp > record.timestamp) {
        continue;
      }
      if (existing.timestamp === record.timestamp && existing.deleted === record.deleted) {
        continue;
      }
    }
    next ??= new Map(previous);
    next.set(record.markId, record);
  }
  return next ?? previous;
}

/** Heading in radians from the pure Y rotation stored on a record. */
function yawOf(record: MarkRecord): number {
  return 2 * Math.atan2(record.qy ?? 0, record.qw ?? 1);
}

/** Live records of one kind in one room. */
function* live(
  marks: MarkMap,
  levelKey: string,
  kind?: (value: MarkRecord["kind"]) => boolean,
): Generator<MarkRecord> {
  for (const record of marks.values()) {
    if (record.deleted || record.levelKey !== levelKey) {
      continue;
    }
    if (kind != null && !kind(record.kind)) {
      continue;
    }
    yield record;
  }
}

const is =
  (wanted: string) =>
  (kind: MarkRecord["kind"]): boolean =>
    kind === wanted;

/** Legacy per-dab paint, from before strokes existed. */
export function foldPaint(marks: MarkMap, levelKey: string): PaintBlob[] {
  const blobs: PaintBlob[] = [];
  for (const record of live(marks, levelKey, is("paint"))) {
    blobs.push({
      id: record.markId,
      position: [record.x ?? 0, record.y ?? 0, record.z ?? 0],
      quaternion: [record.qx ?? 0, record.qy ?? 0, record.qz ?? 0, record.qw ?? 1],
      radius: record.size ?? 0.2,
      color: record.color ?? "#a100ff",
    });
  }
  return blobs;
}

/** Spray strokes, one per press of the trigger. */
export function foldStrokes(marks: MarkMap, levelKey: string): PaintStroke[] {
  const sprayed: PaintStroke[] = [];
  for (const record of live(marks, levelKey, is("stroke"))) {
    const dabs = decodeDabs(record.points);
    if (dabs.length === 0) {
      continue;
    }
    sprayed.push({ id: record.markId, color: record.color ?? "#a100ff", dabs });
  }
  return sprayed;
}

/** Props placed with the objects tool. */
export function foldObjects(marks: MarkMap, levelKey: string): PlacedObject[] {
  const placed: PlacedObject[] = [];
  for (const record of live(marks, levelKey)) {
    if (!isFurnitureKind(record.kind)) {
      continue;
    }
    placed.push({
      id: record.markId,
      kind: record.kind,
      position: [record.x ?? 0, record.y ?? 0, record.z ?? 0],
      yaw: yawOf(record),
    });
  }
  return placed;
}

/** Personal-room doors standing in the room. */
export function foldDoors(marks: MarkMap, levelKey: string): PlacedDoor[] {
  const placed: PlacedDoor[] = [];
  for (const record of live(marks, levelKey, is("door"))) {
    placed.push({
      id: record.markId,
      userId: record.userId,
      position: [record.x ?? 0, record.y ?? 0, record.z ?? 0],
      yaw: yawOf(record),
    });
  }
  return placed;
}

/** Holes dug with the dig tool. */
export function foldCraters(marks: MarkMap, levelKey: string): Crater[] {
  const dug: Crater[] = [];
  for (const record of live(marks, levelKey, is("dig"))) {
    dug.push({
      id: record.markId,
      x: record.x ?? 0,
      z: record.z ?? 0,
      radius: record.size ?? 1.8,
      depth: record.height ?? 1.2,
    });
  }
  return dug;
}

/** Cubes built with the create tool. `width` carries opacity. */
export function foldCubes(marks: MarkMap, levelKey: string): Cube[] {
  const built: Cube[] = [];
  for (const record of live(marks, levelKey, is("cube"))) {
    built.push({
      id: record.markId,
      x: record.x ?? 0,
      y: record.y ?? 0,
      z: record.z ?? 0,
      color: record.color ?? DEFAULT_CUBE_COLOR,
      opacity: record.width ?? DEFAULT_CUBE_OPACITY,
    });
  }
  return built;
}

/**
 * Levelled terrain.
 *
 * A sweep expands into the pads it contains, all sharing the record's level
 * and radius. Expanding here keeps the terrain maths, the chunk invalidation
 * and the collision height field working on a flat list, exactly as they did
 * before sweeps existed. Legacy one-pad-per-record "flat" marks still count.
 */
export function foldPads(marks: MarkMap, levelKey: string): FlatPad[] {
  const levelled: FlatPad[] = [];
  for (const record of live(marks, levelKey)) {
    if (record.kind === "sweep") {
      const points = decodePads(record.points);
      for (let index = 0; index < points.length; index++) {
        levelled.push({
          id: `${record.markId}#${index}`,
          markId: record.markId,
          x: points[index][0],
          z: points[index][1],
          radius: record.size ?? 3,
          level: record.y ?? 0,
        });
      }
      continue;
    }
    if (record.kind === "flat") {
      levelled.push({
        id: record.markId,
        markId: record.markId,
        x: record.x ?? 0,
        z: record.z ?? 0,
        radius: record.size ?? 3,
        level: record.y ?? 0,
      });
    }
  }
  return levelled;
}
