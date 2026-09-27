import { describeError } from "@/foundry/errors";
import { loadRoomSnapshot, loadSharedSnapshot } from "@/foundry/snapshots";
import {
  type CharacterCursor,
  type CharacterRecord,
  isCharacterStreamEnabled,
  readCharacters,
} from "@/foundry/streams/characters";
import {
  type ChatCursor,
  type ChatRecord,
  chatTailCursor,
  isChatEnabled,
  readChat,
} from "@/foundry/streams/chat";
import {
  type MarkRecord,
  type StreamCursor,
  readMarks,
  readMarksSince,
} from "@/foundry/streams/marks";
import {
  type PresenceCursor,
  isPresenceEnabled,
  presenceTailCursor,
  readPresence,
} from "@/foundry/streams/presence";
import type { Crater, Cube, FlatPad, PlacedObject } from "@/game/domain/types";
import {
  type MarkMap,
  foldCraters,
  foldCubes,
  foldObjects,
  foldPads,
  mergeMarks,
} from "@/game/state/markFold";
import { EYE_HEIGHT, type Obstacle, type VoxelWorld } from "@/game/world/collision";
import { obstacleFor } from "@/game/world/furnitureCatalog";
import { buildVoxelMap } from "@/game/world/voxels";
import { type HeightField, buildTerrainSampler } from "@/game/world/worldgen";
import { isAgentSession } from "@/agents/config/identity";
import { type LevelGeometry, levelGeometry } from "@/agents/world/levels";
import { startPolling } from "@/agents/world/poller";

/**
 * What the AI players in one room can see: everyone else's position, what is
 * being said, and what has been built.
 *
 * One per room, shared by every agent in it. The streams are polled once per
 * room rather than once per agent, and each agent reads the shared fold —
 * ten agents cost the same reads as one. Built from exactly the stream
 * modules the game uses, and folded with the same markFold, so an agent sees
 * the cubes a human sees and walks around the same walls.
 */

/** Someone standing in the room, as last heard from. */
export interface WorldPlayer {
  sessionId: string;
  userId: string;
  /** Feet position, not the eye position presence carries. */
  x: number;
  feetY: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  /** Local clock time the last pose arrived. */
  lastSeen: number;
  /** Publisher's timestamp on that pose, for keeping the newest. */
  publishedAt: number;
  isAgent: boolean;
}

/** One chat message heard in this room. */
export interface HeardMessage {
  messageId: string;
  sessionId: string;
  userId: string;
  text: string;
  /** Where it was said from, when the record carried a position. */
  x: number | null;
  z: number | null;
  /** Local clock time it arrived. */
  receivedAt: number;
  isAgent: boolean;
}

export interface WorldLinks {
  presence: string | null;
  chat: string | null;
  marks: string | null;
}

/** Presence polls fast enough to follow someone walking; slower than a human's view. */
const PRESENCE_POLL_MS = 250;
const CHAT_POLL_MS = 500;
const MARKS_POLL_MS = 1500;
const CHARACTERS_POLL_MS = 10000;
/** Players unheard from for this long are gone. Matches usePresence. */
const STALE_AFTER_MS = 10000;
/** Bounded dedupe set for chat, as in useChat. */
const SEEN_LIMIT = 400;

export class WorldView {
  readonly levelKey: string;
  readonly geometry: LevelGeometry;

  private players = new Map<string, WorldPlayer>();
  private marks: MarkMap = new Map();
  private appearances = new Map<string, CharacterRecord>();
  private chatListeners = new Set<(message: HeardMessage) => void>();
  private seenMessages: string[] = [];
  private seenSet = new Set<string>();
  private stops: Array<() => void> = [];
  private presenceCursor: PresenceCursor | null = null;
  private chatCursor: ChatCursor | null = null;
  private markCursor: StreamCursor | null = null;
  private characterCursor: CharacterCursor | null = null;

  /** Bumped whenever the fold changes, so derived state knows to rebuild. */
  private markVersion = 0;
  private derivedVersion = -1;
  private derived: {
    cubes: Cube[];
    objects: PlacedObject[];
    craters: Crater[];
    pads: FlatPad[];
    terrainAt: HeightField;
    world: VoxelWorld;
  } | null = null;

  readonly links: WorldLinks = { presence: null, chat: null, marks: null };

  constructor(levelKey: string) {
    const geometry = levelGeometry(levelKey);
    if (geometry == null) {
      throw new Error(`AI players cannot live in "${levelKey}".`);
    }
    this.levelKey = levelKey;
    this.geometry = geometry;
  }

  start(): void {
    if (this.stops.length > 0) {
      return;
    }

    if (isPresenceEnabled()) {
      this.stops.push(
        startPolling({
          prepare: async () => {
            this.presenceCursor = await presenceTailCursor();
          },
          tick: async (isCancelled) => this.pollPresence(isCancelled),
          intervalMs: PRESENCE_POLL_MS,
        }),
      );
    }

    if (isChatEnabled()) {
      this.stops.push(
        startPolling({
          prepare: async () => {
            this.chatCursor = await chatTailCursor();
          },
          tick: async (isCancelled) => this.pollChat(isCancelled),
          intervalMs: CHAT_POLL_MS,
        }),
      );
    }

    this.stops.push(
      startPolling({
        prepare: async (isCancelled) => this.prepareMarks(isCancelled),
        tick: async (isCancelled) => this.pollMarks(isCancelled),
        intervalMs: MARKS_POLL_MS,
      }),
    );

    if (isCharacterStreamEnabled()) {
      this.stops.push(
        startPolling({
          tick: async (isCancelled) => this.pollCharacters(isCancelled),
          intervalMs: CHARACTERS_POLL_MS,
        }),
      );
    }
  }

  stop(): void {
    for (const stop of this.stops) {
      stop();
    }
    this.stops = [];
  }

  /** Everyone currently in the room, including other agents. */
  roster(now: number = performance.now()): WorldPlayer[] {
    const present: WorldPlayer[] = [];
    for (const [sessionId, player] of this.players) {
      if (now - player.lastSeen > STALE_AFTER_MS) {
        this.players.delete(sessionId);
        continue;
      }
      present.push(player);
    }
    return present;
  }

  /** Body colour a player chose, for describing them. */
  appearanceOf(userId: string): CharacterRecord | null {
    return this.appearances.get(userId) ?? null;
  }

  onChat(listener: (message: HeardMessage) => void): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  /**
   * Marks written by an agent in this tab, folded straight away.
   *
   * The same optimism useMarkSync applies to a human's own writes: a cube is
   * solid the moment it is placed, rather than a stream round trip later, so
   * the agent does not walk into what it just built.
   */
  applyLocalMarks(records: MarkRecord[]): void {
    this.fold(records);
  }

  /** The folded room, rebuilt only when a mark has changed. */
  state(): {
    cubes: Cube[];
    objects: PlacedObject[];
    craters: Crater[];
    pads: FlatPad[];
    terrainAt: HeightField;
    world: VoxelWorld;
  } {
    if (this.derived == null || this.derivedVersion !== this.markVersion) {
      const cubes = foldCubes(this.marks, this.levelKey);
      const objects = foldObjects(this.marks, this.levelKey);
      const craters = foldCraters(this.marks, this.levelKey);
      const pads = foldPads(this.marks, this.levelKey);
      const terrainAt = buildTerrainSampler(craters, pads, this.geometry.base);
      const props: Obstacle[] = objects.map(obstacleFor);
      this.derived = {
        cubes,
        objects,
        craters,
        pads,
        terrainAt,
        world: { voxels: buildVoxelMap(cubes), terrainAt, props },
      };
      this.derivedVersion = this.markVersion;
    }
    return this.derived;
  }

  /** Every live mark in this room, for "erase everything this agent made". */
  marksBy(userId: string): MarkRecord[] {
    const found: MarkRecord[] = [];
    for (const record of this.marks.values()) {
      if (!record.deleted && record.levelKey === this.levelKey && record.userId === userId) {
        found.push(record);
      }
    }
    return found;
  }

  private fold(records: MarkRecord[]): void {
    const relevant = records.filter((record) => record.levelKey === this.levelKey);
    if (relevant.length === 0) {
      return;
    }
    const next = mergeMarks(this.marks, relevant);
    if (next !== this.marks) {
      this.marks = next;
      this.markVersion++;
    }
  }

  private async pollPresence(isCancelled: () => boolean): Promise<void> {
    if (this.presenceCursor == null) {
      this.presenceCursor = await presenceTailCursor();
    }
    try {
      const { records, cursor } = await readPresence(this.presenceCursor);
      if (isCancelled()) {
        return;
      }
      this.presenceCursor = cursor;
      this.links.presence = null;
      const now = performance.now();
      for (const record of records) {
        if (record.levelKey !== this.levelKey && this.players.has(record.sessionId)) {
          // Walked out of this room.
          this.players.delete(record.sessionId);
          continue;
        }
        if (record.levelKey !== this.levelKey) {
          continue;
        }
        if (record.state === "left") {
          this.players.delete(record.sessionId);
          continue;
        }
        const existing = this.players.get(record.sessionId);
        // Partitions are read concurrently, so a batch is not in order.
        if (existing != null && existing.publishedAt > record.timestamp) {
          continue;
        }
        const eyeY = record.y ?? (existing != null ? existing.feetY + EYE_HEIGHT : EYE_HEIGHT);
        this.players.set(record.sessionId, {
          sessionId: record.sessionId,
          userId: record.userId,
          x: record.x ?? existing?.x ?? 0,
          feetY: eyeY - EYE_HEIGHT,
          z: record.z ?? existing?.z ?? 0,
          yaw: record.yaw ?? existing?.yaw ?? 0,
          vx: record.vx ?? 0,
          vz: record.vz ?? 0,
          lastSeen: now,
          publishedAt: record.timestamp,
          isAgent: isAgentSession(record.sessionId),
        });
      }
    } catch (error) {
      this.links.presence = describeError(error);
    }
  }

  private async pollChat(isCancelled: () => boolean): Promise<void> {
    if (this.chatCursor == null) {
      this.chatCursor = await chatTailCursor();
    }
    try {
      const { records, cursor } = await readChat(this.chatCursor);
      if (isCancelled()) {
        return;
      }
      this.chatCursor = cursor;
      this.links.chat = null;
      const now = performance.now();
      const ordered = [...records].sort((a, b) => a.timestamp - b.timestamp);
      for (const record of ordered) {
        if (record.levelKey !== this.levelKey || this.seen(record)) {
          continue;
        }
        const message: HeardMessage = {
          messageId: record.messageId,
          sessionId: record.sessionId,
          userId: record.userId,
          text: record.text,
          x: record.x ?? null,
          z: record.z ?? null,
          receivedAt: now,
          isAgent: isAgentSession(record.sessionId),
        };
        for (const listener of this.chatListeners) {
          listener(message);
        }
      }
    } catch (error) {
      this.links.chat = describeError(error);
    }
  }

  private seen(record: ChatRecord): boolean {
    if (this.seenSet.has(record.messageId)) {
      return true;
    }
    this.seenSet.add(record.messageId);
    this.seenMessages.push(record.messageId);
    if (this.seenMessages.length > SEEN_LIMIT) {
      const dropped = this.seenMessages.shift();
      if (dropped != null) {
        this.seenSet.delete(dropped);
      }
    }
    return false;
  }

  /**
   * The room file first, then only the stream tail since it was written —
   * the same cold start useMarkSync makes, and for the same reason: replaying
   * the whole stream would re-read the entire history of the world.
   */
  private async prepareMarks(isCancelled: () => boolean): Promise<void> {
    const [room, shared] = await Promise.all([
      loadRoomSnapshot(this.levelKey),
      loadSharedSnapshot(),
    ]);
    if (isCancelled()) {
      return;
    }
    this.fold(room.marks);
    if (shared.generatedAt === 0) {
      return;
    }
    try {
      const caughtUp = await readMarksSince(shared.generatedAt);
      if (isCancelled()) {
        return;
      }
      this.fold(caughtUp.records);
      this.markCursor = caughtUp.cursor;
      this.links.marks = null;
    } catch (error) {
      this.links.marks = describeError(error);
    }
  }

  private async pollMarks(isCancelled: () => boolean): Promise<void> {
    try {
      const result = await readMarks(this.markCursor, (page) => {
        if (!isCancelled()) {
          this.fold(page);
        }
      });
      if (isCancelled()) {
        return;
      }
      this.markCursor = result.cursor;
      this.links.marks = null;
    } catch (error) {
      this.links.marks = describeError(error);
    }
  }

  private async pollCharacters(isCancelled: () => boolean): Promise<void> {
    try {
      const { records, cursor } = await readCharacters(this.characterCursor);
      if (isCancelled()) {
        return;
      }
      this.characterCursor = cursor;
      for (const record of records) {
        const existing = this.appearances.get(record.userId);
        if (existing == null || existing.timestamp <= record.timestamp) {
          this.appearances.set(record.userId, record);
        }
      }
    } catch {
      // Appearance is cosmetic; an agent can describe people without it.
    }
  }
}
