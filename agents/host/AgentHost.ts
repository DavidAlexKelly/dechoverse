import { Agent, type AgentServices, type AgentSnapshot, type LogKind } from "@/agents/host/Agent";
import { type JevClient, createJevClient } from "@/agents/brain/jev";
import { logJevStatus } from "@/agents/brain/jevLog";
import type { Persona } from "@/agents/config/personas";
import type { AgentModelName } from "@/agents/data/brainClient";
import { ProjectBoard } from "@/agents/build/project";
import type { LevelGeometry } from "@/agents/world/levels";
import { WorldView } from "@/agents/world/WorldView";
import type { EyePose } from "@/agents/body/Body";
import { describeError } from "@/foundry/errors";
import { CHARACTER_SCHEMA_VERSION, publishCharacter } from "@/foundry/streams/characters";
import { CHAT_SCHEMA_VERSION, publishChat } from "@/foundry/streams/chat";
import { MARK_SCHEMA_VERSION, type MarkRecord, publishMarks } from "@/foundry/streams/marks";
import { estimateSpeechMs } from "@/game/state/speech";
import {
  PRESENCE_SCHEMA_VERSION,
  type PresenceRecord,
  publishPresence,
} from "@/foundry/streams/presence";

/**
 * Runs every AI player in this tab.
 *
 * One WorldView per room, shared by the agents in it. One physics loop for
 * all of them, one presence publish per 100 ms carrying every agent's poses,
 * one mark publish every couple of seconds carrying every agent's cubes —
 * so ten agents cost roughly the stream traffic of one busy human, not ten.
 *
 * Everything is written with the signed-in operator's token, exactly as the
 * operator's own game client would write it; the records' userId is what
 * names the agent.
 *
 * ⚠ KEEP THE TAB VISIBLE. Browsers throttle timers in background tabs to
 * about once a second (and much less after a few minutes), which makes
 * agents stutter and fall behind. A separate window left open works. The
 * Compute Module phase of the plan removes this limitation.
 */

export interface LogEntry {
  at: number;
  agentId: string;
  agentName: string;
  kind: LogKind;
  text: string;
}

export interface HostSnapshot {
  agents: AgentSnapshot[];
  log: LogEntry[];
  jevConfigured: boolean;
  jevModel: string | null;
  jevError: string | null;
  spentDollars: number;
  presenceError: string | null;
  marksError: string | null;
  links: Record<string, { presence: string | null; chat: string | null; marks: string | null }>;
}

export interface SpawnOptions {
  model: AgentModelName;
  levelKey: string;
  hat: string | null;
  color: string;
  /**
   * The room's ground, when the caller has it — the game does, for every
   * room including DechoWorld 2. Without it only the rooms levelGeometry
   * knows are possible.
   */
  geometry?: LevelGeometry;
}

const PHYSICS_MS = 50;
const PRESENCE_FLUSH_MS = 100;
const THINK_SCHEDULER_MS = 200;
const MARK_FLUSH_MS = 2000;
const NOTIFY_MS = 500;
const LOG_LIMIT = 300;
/**
 * Pause after someone finishes speaking before an agent starts: long enough
 * to read as listening, short enough that a conversation still flows.
 */
const SPEECH_GAP_MS = 2500;
/** Never send more than this many poses in one presence batch. */
const MAX_POSES_PER_BATCH = 80;

export class AgentHost {
  private agents = new Map<string, Agent>();
  /** Per room: when the last line heard or said will have finished, plus the gap. */
  private floors = new Map<string, number>();
  /** Builds in progress, shared so one agent can help with another's. */
  private readonly projects = new ProjectBoard();
  private views = new Map<string, { view: WorldView; users: number }>();
  private jev: JevClient | null = null;
  private jevModel: string | null = null;
  private jevError: string | null = null;
  private spent = 0;
  private presenceOutbox: PresenceRecord[] = [];
  private markOutbox: MarkRecord[] = [];
  private presenceError: string | null = null;
  private marksError: string | null = null;
  private log: LogEntry[] = [];
  private listeners = new Set<(snapshot: HostSnapshot) => void>();
  private timers: number[] = [];
  private lastPhysicsAt = performance.now();
  private disposed = false;

  constructor() {
    this.timers.push(window.setInterval(() => this.physics(), PHYSICS_MS));
    this.timers.push(window.setInterval(() => void this.flushPresence(), PRESENCE_FLUSH_MS));
    this.timers.push(window.setInterval(() => this.scheduleThinking(), THINK_SCHEDULER_MS));
    this.timers.push(window.setInterval(() => void this.flushMarks(), MARK_FLUSH_MS));
    this.timers.push(window.setInterval(() => this.notify(), NOTIFY_MS));
    window.addEventListener("pagehide", this.handlePageHide);
  }

  // ── Configuration ──────────────────────────────────────────────────────

  /** Sets (or clears, with an empty key) the OpenRouter key Jev is called with. */
  configureJev(apiKey: string, model: string): void {
    const key = apiKey.trim();
    this.jev = key === "" ? null : createJevClient({ apiKey: key, model: model.trim() || undefined });
    this.jevModel = key === "" ? null : model.trim();
    this.jevError = null;
    logJevStatus(
      key !== "",
      key !== ""
        ? `${model.trim() || "default model"}, key ending …${key.slice(-4)}`
        : "switched off",
    );
    this.notify();
  }

  // ── Spawning ───────────────────────────────────────────────────────────

  has(personaId: string): boolean {
    return this.agents.has(personaId);
  }

  /** A running agent by display name, ignoring case and the robot suffix. */
  findByName(name: string): string | null {
    const wanted = name.trim().toLowerCase();
    for (const agent of this.agents.values()) {
      if (agent.name.toLowerCase() === wanted) {
        return agent.id;
      }
    }
    return null;
  }

  spawn(persona: Persona, options: SpawnOptions): void {
    if (this.agents.has(persona.id) || this.disposed) {
      return;
    }
    const view = this.acquireView(options.levelKey, options.geometry);
    const spawnAt = this.findSpawn(view, persona.home);
    const agent = new Agent(
      { ...persona, color: options.color, hat: options.hat },
      options.model,
      view,
      this.services,
      spawnAt,
    );
    this.agents.set(persona.id, agent);
    this.record(agent, "mode", `Spawned in ${view.geometry.label} with ${options.model}`);

    void publishCharacter([
      {
        timestamp: Date.now(),
        userId: agent.userId,
        color: options.color,
        hat: options.hat,
        hatColor: null,
        schemaVersion: CHARACTER_SCHEMA_VERSION,
      },
    ]).catch((error: unknown) => this.record(agent, "error", `character: ${describeError(error)}`));
    this.notify();
  }

  /** Removes an agent, telling everyone it has left rather than letting it time out. */
  despawn(personaId: string): void {
    const agent = this.agents.get(personaId);
    if (agent == null) {
      return;
    }
    this.agents.delete(personaId);
    agent.dispose();
    this.presenceOutbox = this.presenceOutbox.filter((record) => record.sessionId !== agent.sessionId);
    void publishPresence([this.leftRecord(agent)]).catch(() => undefined);
    this.releaseView(agent.levelKey);
    this.record(agent, "mode", "Despawned");
    this.notify();
  }

  despawnAll(): void {
    for (const id of [...this.agents.keys()]) {
      this.despawn(id);
    }
  }

  setModel(personaId: string, model: AgentModelName): void {
    const agent = this.agents.get(personaId);
    if (agent != null) {
      agent.model = model;
      this.record(agent, "mode", `Model changed to ${model}`);
    }
  }

  /**
   * Erases every mark an agent has made in its current room — the undo for
   * a build gone wrong. Writes the same deleted records the eraser does.
   */
  async eraseMarksBy(personaId: string): Promise<number> {
    const agent = this.agents.get(personaId);
    if (agent == null) {
      return 0;
    }
    const records = agent.view.marksBy(agent.userId).map((record) => ({
      timestamp: Date.now(),
      markId: record.markId,
      levelKey: record.levelKey,
      deleted: true,
      userId: agent.userId,
      sessionId: agent.sessionId,
      schemaVersion: MARK_SCHEMA_VERSION,
    }));
    if (records.length === 0) {
      return 0;
    }
    agent.view.applyLocalMarks(records);
    for (let index = 0; index < records.length; index += 200) {
      await publishMarks(records.slice(index, index + 200));
    }
    this.record(agent, "build", `Erased ${records.length} marks`);
    return records.length;
  }

  /** Stops everything. The host cannot be used again afterwards. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.despawnAll();
    void this.flushMarks();
    this.disposed = true;
    for (const timer of this.timers) {
      window.clearInterval(timer);
    }
    this.timers = [];
    window.removeEventListener("pagehide", this.handlePageHide);
    for (const { view } of this.views.values()) {
      view.stop();
    }
    this.views.clear();
    this.listeners.clear();
  }

  subscribe(listener: (snapshot: HostSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): HostSnapshot {
    const links: HostSnapshot["links"] = {};
    for (const [levelKey, { view }] of this.views) {
      links[levelKey] = { ...view.links };
    }
    return {
      agents: [...this.agents.values()].map((agent) => agent.snapshot()),
      log: this.log.slice(-120),
      jevConfigured: this.jev != null,
      jevModel: this.jevModel,
      jevError: this.jevError,
      spentDollars: this.spent,
      presenceError: this.presenceError,
      marksError: this.marksError,
      links,
    };
  }

  // ── The services agents are given ──────────────────────────────────────

  private readonly services: AgentServices = {
    jev: () => this.jev,
    publishChat: async (agent, text) => {
      const pose = agent.body.eyePose();
      await publishChat([
        {
          timestamp: Date.now(),
          messageId: crypto.randomUUID(),
          sessionId: agent.sessionId,
          userId: agent.userId,
          levelKey: agent.levelKey,
          text,
          x: pose.x,
          y: pose.y,
          z: pose.z,
          schemaVersion: CHAT_SCHEMA_VERSION,
        },
      ]);
    },
    placeCube: (agent, centre, color) => {
      const record: MarkRecord = {
        timestamp: Date.now(),
        markId: crypto.randomUUID(),
        levelKey: agent.levelKey,
        deleted: false,
        userId: agent.userId,
        sessionId: agent.sessionId,
        kind: "cube",
        x: centre.x,
        y: centre.y,
        z: centre.z,
        color,
        // Opacity rides in width, as addCube writes it.
        width: 1,
        schemaVersion: MARK_SCHEMA_VERSION,
      };
      // Solid straight away for every agent in the room, then published in a batch.
      agent.view.applyLocalMarks([record]);
      this.markOutbox.push(record);
      return record.markId;
    },
    eraseMarks: (agent, markIds) => {
      const records: MarkRecord[] = markIds.map((markId) => ({
        timestamp: Date.now(),
        markId,
        levelKey: agent.levelKey,
        deleted: true,
        userId: agent.userId,
        sessionId: agent.sessionId,
        schemaVersion: MARK_SCHEMA_VERSION,
      }));
      agent.view.applyLocalMarks(records);
      this.markOutbox.push(...records);
    },
    projects: this.projects,
    log: (agent, kind, text) => this.record(agent, kind, text),
    spent: (dollars) => {
      this.spent += dollars;
    },
    floorFreeAt: (levelKey) => this.floors.get(levelKey) ?? 0,
    takeFloor: (levelKey, text) => this.extendFloor(levelKey, performance.now(), text),
    jevFatal: (message) => {
      // No credits or a bad key: every call will fail the same way, so stop
      // calling. Agents fall back to their heuristics until it is fixed.
      this.jev = null;
      this.jevError = message;
      logJevStatus(false, `stopped after: ${message}`);
      this.notify();
    },
  };

  // ── Loops ──────────────────────────────────────────────────────────────

  private physics(): void {
    const now = performance.now();
    const dt = Math.min(1.5, (now - this.lastPhysicsAt) / 1000);
    this.lastPhysicsAt = now;
    for (const agent of this.agents.values()) {
      const pose = agent.update(dt, now);
      if (pose != null) {
        this.presenceOutbox.push(this.poseRecord(agent, pose));
      }
    }
  }

  private scheduleThinking(): void {
    const now = performance.now();
    for (const agent of this.agents.values()) {
      void agent.think(now).catch((error: unknown) => {
        this.record(agent, "error", `think: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private async flushPresence(): Promise<void> {
    if (this.presenceOutbox.length === 0) {
      return;
    }
    const batch = this.presenceOutbox.splice(0, MAX_POSES_PER_BATCH);
    try {
      await publishPresence(batch);
      this.presenceError = null;
    } catch (error) {
      this.presenceError = describeError(error);
    }
  }

  private async flushMarks(): Promise<void> {
    if (this.markOutbox.length === 0) {
      return;
    }
    const batch = this.markOutbox.splice(0, this.markOutbox.length);
    try {
      await publishMarks(batch);
      this.marksError = null;
    } catch (error) {
      this.marksError = describeError(error);
      // Put them back: a cube that exists only in this tab would confuse everyone.
      this.markOutbox.unshift(...batch);
    }
  }

  private notify(): void {
    if (this.listeners.size === 0) {
      return;
    }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private handlePageHide = (): void => {
    const records = [...this.agents.values()].map((agent) => this.leftRecord(agent));
    if (records.length > 0) {
      void publishPresence(records).catch(() => undefined);
    }
    void this.flushMarks();
  };

  private acquireView(levelKey: string, geometry?: LevelGeometry): WorldView {
    const existing = this.views.get(levelKey);
    if (existing != null) {
      existing.users++;
      return existing.view;
    }
    const view = new WorldView(levelKey, geometry);
    // Anyone speaking in the room — a human, or an agent in another tab —
    // holds the floor until they will have finished.
    view.onChat((message) => this.extendFloor(levelKey, message.receivedAt, message.text));
    view.start();
    this.views.set(levelKey, { view, users: 1 });
    return view;
  }

  /** The floor is busy until `text`, started at `from`, has been spoken, plus the gap. */
  private extendFloor(levelKey: string, from: number, text: string): void {
    const until = from + estimateSpeechMs(text) + SPEECH_GAP_MS;
    this.floors.set(levelKey, Math.max(this.floors.get(levelKey) ?? 0, until));
  }

  private releaseView(levelKey: string): void {
    const entry = this.views.get(levelKey);
    if (entry == null) {
      return;
    }
    entry.users--;
    if (entry.users <= 0) {
      entry.view.stop();
      this.views.delete(levelKey);
    }
  }

  /** Dry, open ground near the persona's home, spiralling out until found. */
  private findSpawn(view: WorldView, home: [number, number]): { x: number; z: number } {
    const geometry = view.geometry;
    const [homeX, homeZ] =
      geometry.halfSize != null
        ? [Math.max(-geometry.halfSize + 2, Math.min(geometry.halfSize - 2, home[0])),
           Math.max(-geometry.halfSize + 2, Math.min(geometry.halfSize - 2, home[1]))]
        : home;
    const { world } = view.state();
    for (let radius = 0; radius < 200; radius += 2) {
      for (let step = 0; step < Math.max(1, radius * 2); step++) {
        const angle = (step / Math.max(1, radius * 2)) * Math.PI * 2;
        const x = homeX + Math.cos(angle) * radius;
        const z = homeZ + Math.sin(angle) * radius;
        if (geometry.halfSize != null && (Math.abs(x) > geometry.halfSize - 1 || Math.abs(z) > geometry.halfSize - 1)) {
          continue;
        }
        const ground = world.terrainAt(x, z);
        if (geometry.seaLevel == null || ground > geometry.seaLevel + 0.5) {
          return { x, z };
        }
      }
    }
    return { x: homeX, z: homeZ };
  }

  private poseRecord(agent: Agent, pose: EyePose): PresenceRecord {
    return {
      timestamp: Date.now(),
      sessionId: agent.sessionId,
      userId: agent.userId,
      levelKey: agent.levelKey,
      state: "alive",
      x: pose.x,
      y: pose.y,
      z: pose.z,
      yaw: pose.yaw,
      pitch: pose.pitch,
      vx: pose.vx,
      vz: pose.vz,
      weapon: "select",
      schemaVersion: PRESENCE_SCHEMA_VERSION,
    };
  }

  private leftRecord(agent: Agent): PresenceRecord {
    return {
      timestamp: Date.now(),
      sessionId: agent.sessionId,
      userId: agent.userId,
      levelKey: agent.levelKey,
      state: "left",
      schemaVersion: PRESENCE_SCHEMA_VERSION,
    };
  }

  private record(agent: Agent, kind: LogKind, text: string): void {
    this.log.push({ at: Date.now(), agentId: agent.id, agentName: agent.name, kind, text });
    if (this.log.length > LOG_LIMIT) {
      this.log.splice(0, this.log.length - LOG_LIMIT);
    }
  }
}
