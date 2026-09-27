import type { PlannedCube } from "@/agents/brain/parse";
import type { BuildSite } from "@/agents/brain/prompts";
import { cellKey } from "@/agents/build/blueprint";

/**
 * A build in progress, shared by the agents working on it.
 *
 * One agent owns it: it planned it, and it is the one that looks at it and
 * decides what comes next. Any other agent in the same tab may join and take
 * cubes from the same queue, so two agents put up one building together
 * without either needing to know what the other is holding. Everything runs
 * on one thread, so claiming a cube is simply taking it off the queue.
 */
export class BuildProject {
  readonly id = crypto.randomUUID();
  readonly createdAt = Date.now();
  ownerId: string;
  ownerName: string;
  readonly levelKey: string;
  readonly site: BuildSite;
  readonly title: string;
  readonly goal: string;
  palette: string[];

  /** Agents working on it, owner included. */
  readonly members = new Map<string, string>();
  /** Every cube this build has placed, by cell, with the mark it wrote. */
  readonly placed = new Map<string, { markId: string; color: string }>();
  placedCount = 0;
  /** Looks taken so far, and the placed count at the last one. */
  reviews = 0;
  reviewedAt = 0;
  reviewing = false;
  done = false;

  private queue: PlannedCube[];
  private claims = new Map<string, PlannedCube>();

  constructor(options: {
    ownerId: string;
    ownerName: string;
    levelKey: string;
    site: BuildSite;
    title: string;
    goal: string;
    palette: string[];
    cubes: PlannedCube[];
  }) {
    this.ownerId = options.ownerId;
    this.ownerName = options.ownerName;
    this.levelKey = options.levelKey;
    this.site = options.site;
    this.title = options.title;
    this.goal = options.goal;
    this.palette = options.palette;
    this.queue = [...options.cubes];
    this.members.set(options.ownerId, options.ownerName);
  }

  /** Cubes not yet placed: queued, and held by someone on their way to place them. */
  get remaining(): number {
    return this.queue.length + this.claims.size;
  }

  get total(): number {
    return this.placedCount + this.remaining;
  }

  helpersOf(agentId: string): string[] {
    return [...this.members.entries()].filter(([id]) => id !== agentId).map(([, name]) => name);
  }

  join(agentId: string, name: string): void {
    this.members.set(agentId, name);
  }

  /** The cube this agent should place next: the one it holds, or a new one. */
  claim(agentId: string): PlannedCube | null {
    const held = this.claims.get(agentId);
    if (held != null) {
      return held;
    }
    const next = this.queue.shift();
    if (next == null) {
      return null;
    }
    this.claims.set(agentId, next);
    return next;
  }

  /** The held cube is in place. */
  placedBy(agentId: string, markId: string): void {
    const cube = this.claims.get(agentId);
    if (cube == null) {
      return;
    }
    this.claims.delete(agentId);
    this.placed.set(cellKey(cube), { markId, color: cube.color });
    this.placedCount++;
  }

  /** The held cube's cell was filled by someone else; nothing to place. */
  skip(agentId: string): void {
    this.claims.delete(agentId);
  }

  /** An agent stops working on it. Returns the new owner, if ownership moved. */
  leave(agentId: string): string | null {
    const held = this.claims.get(agentId);
    if (held != null) {
      this.claims.delete(agentId);
      this.queue.unshift(held);
    }
    this.members.delete(agentId);
    if (agentId !== this.ownerId) {
      return null;
    }
    const [heir] = this.members.entries();
    if (heir == null) {
      this.done = true;
      return null;
    }
    this.ownerId = heir[0];
    this.ownerName = heir[1];
    return heir[0];
  }

  /** Cells still to be placed, queued or held. */
  queuedKeys(): Set<string> {
    return new Set([...this.queue, ...this.claims.values()].map(cellKey));
  }

  /** More cubes from a look at the build, after anything still queued. */
  append(cubes: PlannedCube[]): void {
    const queued = new Set(this.queue.map(cellKey));
    for (const cube of cubes) {
      if (!queued.has(cellKey(cube)) && !this.placed.has(cellKey(cube))) {
        this.queue.push(cube);
      }
    }
  }

  /**
   * Takes cells out: drops them from the queue, and returns the marks this
   * build placed there so they can be erased. Never anyone else's cubes.
   */
  remove(keys: string[]): string[] {
    const wanted = new Set(keys);
    this.queue = this.queue.filter((cube) => !wanted.has(cellKey(cube)));
    const markIds: string[] = [];
    for (const key of wanted) {
      const placed = this.placed.get(key);
      if (placed != null) {
        markIds.push(placed.markId);
        this.placed.delete(key);
      }
    }
    return markIds;
  }

  finish(): void {
    this.done = true;
    this.queue = [];
    this.claims.clear();
  }
}

/** Every build in progress in this tab, so agents can find one to join. */
export class ProjectBoard {
  private projects = new Map<string, BuildProject>();

  add(project: BuildProject): void {
    this.projects.set(project.id, project);
  }

  get(id: string): BuildProject | null {
    const project = this.projects.get(id);
    return project != null && !project.done ? project : null;
  }

  /** Unfinished builds in a room within `radius` of a point, nearest first. */
  near(levelKey: string, x: number, z: number, radius: number): BuildProject[] {
    const found: Array<{ project: BuildProject; distance: number }> = [];
    for (const [id, project] of this.projects) {
      if (project.done) {
        this.projects.delete(id);
        continue;
      }
      if (project.levelKey !== levelKey) {
        continue;
      }
      const centreX = project.site.cellX + project.site.size / 2;
      const centreZ = project.site.cellZ + project.site.size / 2;
      const distance = Math.hypot(centreX - x, centreZ - z);
      if (distance <= radius) {
        found.push({ project, distance });
      }
    }
    return found.sort((a, b) => a.distance - b.distance).map((entry) => entry.project);
  }
}
