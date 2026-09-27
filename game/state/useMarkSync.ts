import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as THREE from "three";
import { describeError } from "@/foundry/errors";
import { loadRoomSnapshot, loadSharedSnapshot } from "@/foundry/snapshots";
import {
  MARK_SCHEMA_VERSION,
  type MarkRecord,
  type StreamCursor,
  publishMarks,
  readMarks,
  readMarksSince,
} from "@/foundry/streams/marks";
import { loadTagTexture } from "@/foundry/tagMedia";
import {
  MAX_STROKE_DABS,
  MAX_SWEEP_PADS,
  decodeDabs,
  decodePads,
  encodeDabs,
  encodePads,
} from "@/game/domain/codec";
import type {
  Crater,
  Cube,
  Dab,
  FlatPad,
  FurnitureKind,
  PaintBlob,
  PaintStroke,
  PlacedDoor,
  PlacedObject,
  TagDecal,
} from "@/game/domain/types";
import { usePolling } from "@/game/state/usePolling";
import { isFurnitureKind } from "@/game/world/furnitureCatalog";
import { DEFAULT_CUBE_COLOR, DEFAULT_CUBE_OPACITY } from "@/game/world/voxels";

export type SyncStatus = "loading" | "live" | "offline";

interface Options {
  /** Marks are scoped to the room they were made in. */
  levelKey: string;
  sessionId: string;
  userId: string;
  /**
   * Blocks writes to the current room, for visiting someone else's personal
   * room. Records that are not scoped to this room — the shared tag image
   * library — still go through.
   *
   * A convenience for honest visitors, not a security boundary: the stream is
   * writable by anyone who can reach it, so this stops the tools, not a
   * determined client.
   */
  readOnly?: boolean;
}

/** A prop being placed with the objects tool. */
export interface NewObject {
  kind: FurnitureKind;
  position: [number, number, number];
  yaw: number;
}

/** A tag being placed: geometry plus the media item that backs it. */
export interface NewTag {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  width: number;
  height: number;
  imageRid: string;
  /** Already-decoded texture, so the paste renders without a round trip. */
  texture: THREE.Texture;
}

export interface MarkSync {
  /**
   * Legacy per-dab paint, from before strokes existed. Still rendered so no
   * existing artwork disappears, but nothing writes these any more.
   */
  paint: PaintBlob[];
  /** Spray strokes for the current room, one per press of the trigger. */
  strokes: PaintStroke[];
  /** Tags for the current room whose image has finished downloading. */
  tags: TagDecal[];
  /** Props placed in the current room with the objects tool. */
  objects: PlacedObject[];
  /** Personal-room doors standing in the current room. */
  doors: PlacedDoor[];
  /** Holes dug in the current room's terrain. */
  craters: Crater[];
  /** Cubes built in the current room. */
  cubes: Cube[];
  /** Patches of terrain levelled in the current room. */
  pads: FlatPad[];
  status: SyncStatus;
  /** Last stream error, so the HUD can say why syncing stopped. */
  error: string | null;
  /** Marks currently held in memory across every room. */
  markCount: number;
  /** Media item RIDs known to the world, newest first, for the tag picker. */
  imageLibrary: string[];
  /** Commits one finished spray stroke as a single mark. */
  addStroke: (color: string, dabs: Dab[]) => void;
  addTag: (tag: NewTag) => void;
  addObject: (object: NewObject) => void;
  /** Places this player's door, replacing any they had elsewhere. */
  placeDoor: (position: [number, number, number], yaw: number) => void;
  /** Digs a bowl out of the terrain. */
  addCrater: (x: number, z: number, radius: number, depth: number) => void;
  /** Places a coloured cube at a grid cell centre. */
  addCube: (x: number, y: number, z: number, color: string, opacity: number) => void;
  /** Commits one finished flatten sweep as a single mark. */
  addSweep: (level: number, radius: number, pads: Array<[number, number]>) => void;
  /** Records an uploaded image so it shows up in the picker before use. */
  registerImage: (imageRid: string) => void;
  removeMarks: (markIds: string[]) => void;
}

/** Pseudo-room used by library-only records. */
const LIBRARY_LEVEL_KEY = "library";

/** Wait this long after the last tick before publishing a stroke. */
const FLUSH_DEBOUNCE_MS = 700;
/** Publish immediately once a stroke gets this long. */
const FLUSH_MAX_BUFFER = 40;
const POLL_INTERVAL_MS = 1500;
/** Guard against a room with an absurd amount of legacy per-dab paint. */
const MAX_RENDERED_PAINT = 900;
/** Strokes are one draw call each, so a room can hold a great many. */
const MAX_RENDERED_STROKES = 400;

/**
 * Persists paint and tags to the [AP] Server State stream and keeps the local
 * scene in sync with what other players publish.
 *
 * Writes are optimistic: the mark renders immediately, is buffered, and the
 * whole stroke is published in one call. Reads replay the stream on load and
 * then poll for new records. Tag images live in the [AP] tags media set; the
 * stream only carries the media item RID, and textures are fetched lazily and
 * cached per RID. If the stream is unreachable (for example the streams API
 * scopes are not enabled yet) the game keeps working locally and the status
 * flips to "offline".
 */
export function useMarkSync({ levelKey, sessionId, userId, readOnly = false }: Options): MarkSync {
  const [marks, setMarks] = useState<Map<string, MarkRecord>>(() => new Map<string, MarkRecord>());
  const [textures, setTextures] = useState<Map<string, THREE.Texture>>(
    () => new Map<string, THREE.Texture>(),
  );
  const [status, setStatus] = useState<SyncStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  /**
   * Mirror of `marks` for callbacks that must read the current state without
   * being rebuilt whenever a mark changes — placing a door has to scan every
   * mark, and re-creating that callback on each paint tick would be wasteful.
   */
  const marksRef = useRef(marks);
  marksRef.current = marks;
  /** Write guard, in a ref so `queue` is not rebuilt when the room changes. */
  const guardRef = useRef({ readOnly, levelKey });
  guardRef.current = { readOnly, levelKey };
  const cursorRef = useRef<StreamCursor | null>(null);
  const pendingRef = useRef<MarkRecord[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  const loadingTexturesRef = useRef<Set<string>>(new Set());

  /** Folds records into state, newest timestamp per markId wins. */
  const apply = useCallback((records: MarkRecord[]) => {
    if (records.length === 0) {
      return;
    }
    setMarks((previous) => {
      let changed = false;
      const next = new Map(previous);
      for (const record of records) {
        const existing = next.get(record.markId);
        if (existing != null) {
          if (existing.timestamp > record.timestamp) {
            continue;
          }
          if (existing.timestamp === record.timestamp && existing.deleted === record.deleted) {
            continue;
          }
        }
        next.set(record.markId, record);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, []);

  const flush = useCallback(async () => {
    const batch = pendingRef.current;
    pendingRef.current = [];
    if (batch.length === 0) {
      return;
    }
    try {
      await publishMarks(batch);
      setStatus((previous) => (previous === "offline" ? "live" : previous));
    } catch (publishError) {
      setError(`publish: ${describeError(publishError)}`);
      setStatus("offline");
    }
  }, []);

  /** Renders the records straight away, then publishes them as one batch. */
  const queue = useCallback(
    (records: MarkRecord[]) => {
      // Enforced here rather than at each call site: there are eight ways to
      // add a mark, and the invariant should not depend on every one of them
      // remembering. Records aimed at another room — the shared image
      // library — are unaffected.
      const guard = guardRef.current;
      const allowed = guard.readOnly
        ? records.filter((record) => record.levelKey !== guard.levelKey)
        : records;
      if (allowed.length === 0) {
        return;
      }

      apply(allowed);
      pendingRef.current.push(...allowed);

      if (pendingRef.current.length >= FLUSH_MAX_BUFFER) {
        if (flushTimerRef.current != null) {
          window.clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        void flush();
        return;
      }

      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current);
      }
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        void flush();
      }, FLUSH_DEBOUNCE_MS);
    },
    [apply, flush],
  );

  /**
   * One press of the spray can, one record.
   *
   * Previously every tick of the trigger wrote its own mark, so a few seconds
   * of painting was ninety-odd records on a stream that is replayed from the
   * beginning on every load. The dabs now ride together in `points`.
   */
  const addStroke = useCallback(
    (color: string, dabs: Dab[]) => {
      if (dabs.length === 0) {
        return;
      }
      queue([
        {
          timestamp: Date.now(),
          markId: crypto.randomUUID(),
          levelKey,
          deleted: false,
          userId,
          sessionId,
          kind: "stroke",
          color,
          points: encodeDabs(dabs.slice(0, MAX_STROKE_DABS)),
          schemaVersion: MARK_SCHEMA_VERSION,
        },
      ]);
    },
    [queue, levelKey, sessionId, userId],
  );

  const addTag = useCallback(
    (tag: NewTag) => {
      // Seed the cache so the placing player never waits on a download.
      setTextures((previous) => {
        if (previous.has(tag.imageRid)) {
          return previous;
        }
        const next = new Map(previous);
        next.set(tag.imageRid, tag.texture);
        return next;
      });

      queue([
        {
          timestamp: Date.now(),
          markId: crypto.randomUUID(),
          levelKey,
          deleted: false,
          userId,
          sessionId,
          kind: "tag",
          x: tag.position[0],
          y: tag.position[1],
          z: tag.position[2],
          qx: tag.quaternion[0],
          qy: tag.quaternion[1],
          qz: tag.quaternion[2],
          qw: tag.quaternion[3],
          width: tag.width,
          height: tag.height,
          imageRid: tag.imageRid,
          schemaVersion: MARK_SCHEMA_VERSION,
        },
      ]);
    },
    [queue, levelKey, sessionId, userId],
  );

  const registerImage = useCallback(
    (imageRid: string) => {
      queue([
        {
          timestamp: Date.now(),
          markId: crypto.randomUUID(),
          levelKey: LIBRARY_LEVEL_KEY,
          deleted: false,
          userId,
          sessionId,
          kind: "image",
          imageRid,
          schemaVersion: MARK_SCHEMA_VERSION,
        },
      ]);
    },
    [queue, sessionId, userId],
  );

  const addObject = useCallback(
    (object: NewObject) => {
      // Only a heading matters for a prop standing on the floor, so the
      // quaternion is a pure Y rotation.
      const half = object.yaw / 2;
      queue([
        {
          timestamp: Date.now(),
          markId: crypto.randomUUID(),
          levelKey,
          deleted: false,
          userId,
          sessionId,
          // The prop type rides in `kind`, which keeps the stream schema as is.
          kind: object.kind,
          x: object.position[0],
          y: object.position[1],
          z: object.position[2],
          qx: 0,
          qy: Math.sin(half),
          qz: 0,
          qw: Math.cos(half),
          schemaVersion: MARK_SCHEMA_VERSION,
        },
      ]);
    },
    [queue, levelKey, sessionId, userId],
  );

  /**
   * Places this player's personal-room door.
   *
   * Exactly one door per person may exist, anywhere in the world, so any
   * earlier door of theirs is tombstoned in the same batch. Doing it here
   * rather than at the call site keeps the invariant in one place.
   */
  const placeDoor = useCallback(
    (position: [number, number, number], yaw: number) => {
      const timestamp = Date.now();
      const half = yaw / 2;

      const superseded: MarkRecord[] = [];
      for (const record of marksRef.current.values()) {
        if (record.kind === "door" && !record.deleted && record.userId === userId) {
          superseded.push({
            timestamp,
            markId: record.markId,
            levelKey: record.levelKey,
            deleted: true,
            userId,
            sessionId,
            schemaVersion: MARK_SCHEMA_VERSION,
          });
        }
      }

      queue([
        ...superseded,
        {
          timestamp,
          markId: crypto.randomUUID(),
          levelKey,
          deleted: false,
          userId,
          sessionId,
          kind: "door",
          x: position[0],
          y: position[1],
          z: position[2],
          qx: 0,
          qy: Math.sin(half),
          qz: 0,
          qw: Math.cos(half),
          schemaVersion: MARK_SCHEMA_VERSION,
        },
      ]);
    },
    [queue, levelKey, sessionId, userId],
  );

  const addCrater = useCallback(
    (x: number, z: number, radius: number, depth: number) => {
      queue([
        {
          timestamp: Date.now(),
          markId: crypto.randomUUID(),
          levelKey,
          deleted: false,
          userId,
          sessionId,
          kind: "dig",
          x,
          y: 0,
          z,
          // Radius and depth reuse the existing geometry columns.
          size: radius,
          height: depth,
          schemaVersion: MARK_SCHEMA_VERSION,
        },
      ]);
    },
    [queue, levelKey, sessionId, userId],
  );

  const addCube = useCallback(
    (x: number, y: number, z: number, color: string, opacity: number) => {
      queue([
        {
          timestamp: Date.now(),
          markId: crypto.randomUUID(),
          levelKey,
          deleted: false,
          userId,
          sessionId,
          kind: "cube",
          x,
          y,
          z,
          color,
          // A cube has no width of its own — it is a cube — so the column
          // carries how solid it looks, the same way dig puts its radius and
          // depth in size and height. Records without it are from before
          // opacity existed and read back as fully solid.
          width: opacity,
          schemaVersion: MARK_SCHEMA_VERSION,
        },
      ]);
    },
    [queue, levelKey, sessionId, userId],
  );

  /**
   * One sweep of the flatten tool, one record.
   *
   * Same reasoning as spray strokes: this used to write a pad every metre or
   * so of aim movement, which made it the fastest growing writer in the game
   * per second of use. The pads now ride together in `points`, with the level
   * and radius they all share kept in y and size.
   */
  const addSweep = useCallback(
    (level: number, radius: number, pads: Array<[number, number]>) => {
      if (pads.length === 0) {
        return;
      }
      queue([
        {
          timestamp: Date.now(),
          markId: crypto.randomUUID(),
          levelKey,
          deleted: false,
          userId,
          sessionId,
          kind: "sweep",
          // The levelled height rides in y, the brush radius in size.
          y: level,
          size: radius,
          points: encodePads(pads.slice(0, MAX_SWEEP_PADS)),
          schemaVersion: MARK_SCHEMA_VERSION,
        },
      ]);
    },
    [queue, levelKey, sessionId, userId],
  );

  const removeMarks = useCallback(
    (markIds: string[]) => {
      if (markIds.length === 0) {
        return;
      }
      const timestamp = Date.now();
      queue(
        markIds.map((markId) => ({
          timestamp,
          markId,
          levelKey,
          deleted: true,
          userId,
          sessionId,
          schemaVersion: MARK_SCHEMA_VERSION,
        })),
      );
    },
    [queue, levelKey, sessionId, userId],
  );

  /**
   * Doors and the tag library, loaded once and kept for the session.
   *
   * These are read from the whole history rather than from the current room,
   * so a room snapshot cannot supply them and neither can a stream that has
   * been trimmed. Without this the tag gallery would lose anything older than
   * the retention window, and a door placed today would not retire the one
   * placed last week.
   */
  useEffect(() => {
    let cancelled = false;
    void loadSharedSnapshot().then((snapshot) => {
      if (!cancelled && snapshot.marks.length > 0) {
        apply(snapshot.marks);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  // Seed the room from its snapshot file the moment it is entered.
  //
  // This is what makes entering a room cost that room rather than the whole
  // world: the scene draws from a few hundred marks straight away, while the
  // full stream replay below carries on in the background and folds over the
  // top. Anything the snapshot already had is a no-op in the fold, and
  // anything published since simply wins on timestamp.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const snapshot = await loadRoomSnapshot(levelKey);
      if (!cancelled && snapshot.marks.length > 0) {
        apply(snapshot.marks);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [levelKey, apply]);

  // Replay on mount, then poll for whatever other players have published.
  usePolling({
    /*
     * The first read is bounded by how old the state file is, rather than
     * starting at offset zero.
     *
     * [AP] Server History already holds everything as of its last run, so
     * replaying the whole stream re-reads the entire history of the world to
     * learn nothing. Reading back only as far as that run makes a cold start
     * cost the fold interval instead — the same however old the world gets.
     *
     * Any file will do for the boundary, since every file a run writes shares
     * its timestamp, and the shared one is fetched on every load anyway.
     * Without a file the cursor stays null and the first tick replays in full,
     * which is the correct fallback when there is no state to lean on.
     */
    prepare: async (isCancelled) => {
      const snapshot = await loadSharedSnapshot();
      if (isCancelled() || snapshot.generatedAt === 0) {
        return;
      }
      try {
        const caughtUp = await readMarksSince(snapshot.generatedAt);
        if (isCancelled()) {
          return;
        }
        apply(caughtUp.records);
        cursorRef.current = caughtUp.cursor;
        setStatus("live");
      } catch (readError) {
        // Leaving the cursor null falls back to a full replay in the tick.
        if (!isCancelled()) {
          setError(`read: ${describeError(readError)}`);
        }
      }
    },
    tick: async (isCancelled) => {
      try {
        // Pages are folded in as they arrive rather than all at the end, so a
        // cold start fills the room in progressively instead of leaving it
        // empty until the whole history has been read.
        const result = await readMarks(cursorRef.current, (page) => {
          if (!isCancelled()) {
            apply(page);
          }
        });
        if (isCancelled()) {
          return;
        }
        cursorRef.current = result.cursor;
        setStatus("live");
      } catch (readError) {
        if (!isCancelled()) {
          setError(`read: ${describeError(readError)}`);
          setStatus("offline");
        }
      }
    },
    intervalMs: POLL_INTERVAL_MS,
  });

  // Best effort flush when the tab goes away mid-stroke.
  useEffect(() => {
    const handlePageHide = (): void => void flush();
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [flush]);

  // Pull down the images for any tag in this room we have not seen before.
  useEffect(() => {
    const missing = new Set<string>();
    for (const record of marks.values()) {
      if (record.deleted || record.kind !== "tag") {
        continue;
      }
      if (record.levelKey !== levelKey || record.imageRid == null) {
        continue;
      }
      if (!textures.has(record.imageRid) && !loadingTexturesRef.current.has(record.imageRid)) {
        missing.add(record.imageRid);
      }
    }
    if (missing.size === 0) {
      return;
    }

    let cancelled = false;
    for (const imageRid of missing) {
      loadingTexturesRef.current.add(imageRid);
      void loadTagTexture(imageRid)
        .then(({ texture }) => {
          if (cancelled) {
            return;
          }
          setTextures((previous) => {
            const next = new Map(previous);
            next.set(imageRid, texture);
            return next;
          });
        })
        .catch(() => undefined)
        .finally(() => loadingTexturesRef.current.delete(imageRid));
    }

    return () => {
      cancelled = true;
    };
  }, [marks, textures, levelKey]);

  const paint = useMemo(() => {
    const blobs: PaintBlob[] = [];
    for (const record of marks.values()) {
      if (record.deleted || record.kind !== "paint") {
        continue;
      }
      if (record.levelKey !== levelKey) {
        continue;
      }
      blobs.push({
        id: record.markId,
        position: [record.x ?? 0, record.y ?? 0, record.z ?? 0],
        quaternion: [record.qx ?? 0, record.qy ?? 0, record.qz ?? 0, record.qw ?? 1],
        radius: record.size ?? 0.2,
        color: record.color ?? "#a100ff",
      });
    }
    return blobs.length > MAX_RENDERED_PAINT
      ? blobs.slice(blobs.length - MAX_RENDERED_PAINT)
      : blobs;
  }, [marks, levelKey]);

  const strokes = useMemo(() => {
    const sprayed: PaintStroke[] = [];
    for (const record of marks.values()) {
      if (record.deleted || record.kind !== "stroke" || record.levelKey !== levelKey) {
        continue;
      }
      const dabs = decodeDabs(record.points);
      if (dabs.length === 0) {
        continue;
      }
      sprayed.push({
        id: record.markId,
        color: record.color ?? "#a100ff",
        dabs,
      });
    }
    // The cap counts strokes rather than dabs now, so a room holds far more
    // paint than it used to before anything is dropped.
    return sprayed.length > MAX_RENDERED_STROKES
      ? sprayed.slice(sprayed.length - MAX_RENDERED_STROKES)
      : sprayed;
  }, [marks, levelKey]);

  const tags = useMemo(() => {
    const decals: TagDecal[] = [];
    for (const record of marks.values()) {
      if (record.deleted || record.kind !== "tag") {
        continue;
      }
      if (record.levelKey !== levelKey || record.imageRid == null) {
        continue;
      }
      const texture = textures.get(record.imageRid);
      if (texture == null) {
        continue;
      }
      decals.push({
        id: record.markId,
        position: [record.x ?? 0, record.y ?? 0, record.z ?? 0],
        quaternion: [record.qx ?? 0, record.qy ?? 0, record.qz ?? 0, record.qw ?? 1],
        width: record.width ?? 1,
        height: record.height ?? 1,
        texture,
      });
    }
    return decals;
  }, [marks, textures, levelKey]);

  const objects = useMemo(() => {
    const placed: PlacedObject[] = [];
    for (const record of marks.values()) {
      if (record.deleted || record.levelKey !== levelKey) {
        continue;
      }
      if (!isFurnitureKind(record.kind)) {
        continue;
      }
      // Recover the heading from the pure Y rotation stored on the record.
      const yaw = 2 * Math.atan2(record.qy ?? 0, record.qw ?? 1);
      placed.push({
        id: record.markId,
        kind: record.kind,
        position: [record.x ?? 0, record.y ?? 0, record.z ?? 0],
        yaw,
      });
    }
    return placed;
  }, [marks, levelKey]);

  const doors = useMemo(() => {
    const placed: PlacedDoor[] = [];
    for (const record of marks.values()) {
      if (record.deleted || record.kind !== "door" || record.levelKey !== levelKey) {
        continue;
      }
      placed.push({
        id: record.markId,
        userId: record.userId,
        position: [record.x ?? 0, record.y ?? 0, record.z ?? 0],
        yaw: 2 * Math.atan2(record.qy ?? 0, record.qw ?? 1),
      });
    }
    return placed;
  }, [marks, levelKey]);

  const craters = useMemo(() => {
    const dug: Crater[] = [];
    for (const record of marks.values()) {
      if (record.deleted || record.kind !== "dig" || record.levelKey !== levelKey) {
        continue;
      }
      dug.push({
        id: record.markId,
        x: record.x ?? 0,
        z: record.z ?? 0,
        radius: record.size ?? 1.8,
        depth: record.height ?? 1.2,
      });
    }
    return dug;
  }, [marks, levelKey]);

  const cubes = useMemo(() => {
    const built: Cube[] = [];
    for (const record of marks.values()) {
      if (record.deleted || record.kind !== "cube" || record.levelKey !== levelKey) {
        continue;
      }
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
  }, [marks, levelKey]);

  const pads = useMemo(() => {
    const levelled: FlatPad[] = [];
    for (const record of marks.values()) {
      if (record.deleted || record.levelKey !== levelKey) {
        continue;
      }

      // A sweep expands into the pads it contains, all sharing the record's
      // level and radius. Expanding here keeps the terrain maths, the chunk
      // invalidation and the collision height field working on a flat list,
      // exactly as they did before sweeps existed.
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

      // Legacy one-pad-per-record marks, from before sweeps.
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
  }, [marks, levelKey]);

  const imageLibrary = useMemo(() => {
    const newestByRid = new Map<string, number>();
    for (const record of marks.values()) {
      if (record.imageRid == null) {
        continue;
      }
      const seen = newestByRid.get(record.imageRid) ?? 0;
      if (record.timestamp > seen) {
        newestByRid.set(record.imageRid, record.timestamp);
      }
    }
    return [...newestByRid.entries()].sort((a, b) => b[1] - a[1]).map(([imageRid]) => imageRid);
  }, [marks]);

  return {
    paint,
    strokes,
    tags,
    objects,
    doors,
    craters,
    cubes,
    pads,
    status,
    error,
    markCount: marks.size,
    imageLibrary,
    addStroke,
    addTag,
    addObject,
    placeDoor,
    addCrater,
    addCube,
    addSweep,
    registerImage,
    removeMarks,
  };
}
