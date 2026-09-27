import { Body, yawTowards } from "@/agents/body/Body";
import { PoseSampler } from "@/agents/body/poseSampler";
import { type JevClient, JevError, noul } from "@/agents/brain/jev";
import { recall, remember } from "@/agents/brain/memory";
import { type BuildPlan, parseDecide, parsePlan, parseReply } from "@/agents/brain/parse";
import {
  type ConversationLine,
  type DecideOption,
  type PromptMessage,
  type ReplyAction,
  buildDecidePrompt,
  buildPlanPrompt,
  buildReplyPrompt,
} from "@/agents/brain/prompts";
import {
  ANSWER_OPTIONS,
  MODERATION_QUESTIONS,
  MODERATION_THRESHOLD,
  questionsFor,
  readReflexes,
} from "@/agents/brain/questions";
import {
  type Intent,
  type MindState,
  type Mode,
  NO_REFLEXES,
  PRIMARY_MODES,
  type PendingMessage,
  type Reflexes,
  type Situation,
  applyMode,
  decide,
  initialMind,
} from "@/agents/brain/stateMachine";
import { agentSessionId, agentUserId, plainName } from "@/agents/config/identity";
import type { Persona } from "@/agents/config/personas";
import {
  type AgentModelName,
  BrainCallError,
  type BrainQueryKind,
  foundryModelCall,
} from "@/agents/data/brainClient";
import { cubeCentre, findBuildSites } from "@/agents/world/sites";
import { nearbyColours, summarise } from "@/agents/world/summarise";
import type { HeardMessage, WorldPlayer, WorldView } from "@/agents/world/WorldView";
import type { EyePose } from "@/agents/body/Body";
import { HEARING_RADIUS, SHOUT_RADIUS } from "@/game/state/useChat";
import { bubbleDurationMs, isShout } from "@/game/state/speech";
import { cellOf, hasCube } from "@/game/world/voxels";

/**
 * One AI player: a body in a room, a mind that decides, and the calls that
 * make it speak and build.
 *
 * The three layers of the plan meet here and nowhere else:
 *
 *   1. game logic  — Body (walking, collision), sites.ts, the budgets below
 *   2. Jev         — think(): one reflex request, typed answers → Reflexes
 *   3. LLM         — the dechoAgent* queries, only for words, goals and plans
 *
 * The decisions themselves are stateMachine.ts's; this class gathers the
 * situation it decides over and carries out the intents it returns.
 */

/** What the host provides: publishing, the shared Jev client, logging. */
export interface AgentServices {
  jev: () => JevClient | null;
  publishChat: (agent: Agent, text: string) => Promise<void>;
  placeCube: (agent: Agent, centre: { x: number; y: number; z: number }, color: string) => void;
  log: (agent: Agent, kind: LogKind, text: string) => void;
  /** Called when a Jev call reports its cost, for the console's meter. */
  spent: (dollars: number) => void;
  /** Called when a Jev failure should stop every agent (no credits, bad key). */
  jevFatal: (message: string) => void;
}

export type LogKind = "mode" | "heard" | "said" | "jev" | "llm" | "build" | "error";

export interface AgentSnapshot {
  id: string;
  name: string;
  userId: string;
  levelKey: string;
  model: AgentModelName;
  mode: Mode;
  goal: string | null;
  partner: string | null;
  plan: { title: string; placed: number; total: number } | null;
  position: [number, number, number];
  lastSaid: string | null;
  reflexes: Reflexes | null;
  jev: { calls: number; failures: number; lastLatencyMs: number; error: string | null };
  brain: { calls: number; failures: number; busy: string | null; error: string | null };
}

// ── Cadence and budgets ──────────────────────────────────────────────────
/** Jev is asked this often while something is going on… */
const THINK_ACTIVE_MS = 900;
/** …and this often while idle. A chat or an approaching player wakes it at once. */
const THINK_IDLE_MS = 2500;
/** With no Jev at all, the heuristics still run on this beat. */
const THINK_WITHOUT_JEV_MS = 1000;
/** Per agent, from the plan's budget table. */
const MIN_GAP_MS: Record<BrainQueryKind, number> = {
  reply: 4000,
  // Long enough that an agent does not redesign mid-build, short enough that
  // "build something else" can be acted on straight away.
  plan: 30000,
  decide: 10000,
};
/** After a failed brain query, back off this long, doubling to the cap. */
const BRAIN_BACKOFF_MS = 2000;
const BRAIN_BACKOFF_MAX_MS = 30000;
/** Messages older than this are no longer worth answering. */
const PENDING_TTL_MS = 30000;
const RECENT_CHAT = 12;
const CONVERSATION_LINES = 8;
/** Greet the same person unprompted at most this often. */
const GREET_EVERY_MS = 5 * 60 * 1000;
/** A spoken line waits at most this long for the bubble lock to clear. */
const SAY_QUEUE_TTL_MS = 10000;
/** Extra gap after a bubble ends before the next line. */
const SAY_GAP_MS = 3000;
/** A player coming within this range wakes the mind. */
const WAKE_RANGE = 12;
/** Cube placement rate, from the plan's write budget. */
const CUBES_PER_MINUTE = 20;
/** How far away an agent may place a cube from. */
const BUILD_REACH = 5;
/** Re-path towards a moving person at most this often. */
const REPATH_MS = 1500;
const MAX_PLAN_CUBES = 200;

export class Agent {
  readonly id: string;
  readonly name: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly persona: Persona;
  model: AgentModelName;

  readonly body: Body;
  private readonly sampler = new PoseSampler();
  private mind: MindState;

  private goal: string | null = null;
  private plan: BuildPlan | null = null;
  private placed = 0;
  private nextCubeAt = 0;
  private waypoint: { x: number; z: number } | null = null;
  /**
   * A build asked for while the brain was busy or the plan budget was spent:
   * kept, and planned as soon as a query may run, rather than forgotten.
   */
  private planWanted: { near: { sessionId: string } | null } | null = null;
  /** Told to stay put: keep facing people, but do not walk after them. */
  private staying = false;
  /** Failed attempts to reach the build site, for giving up without Jev. */
  private buildRouteFailures = 0;
  private visited: Array<{ x: number; z: number }> = [];

  private recentChat: HeardMessage[] = [];
  private pendingMessages: Array<PendingMessage & { message: HeardMessage }> = [];
  private messageSerial = 0;
  private conversation: ConversationLine[] = [];
  private greeted = new Map<string, number>();
  private agentTurnTimes: number[] = [];
  private lastSaid: string | null = null;
  private lastSaidAt = -Infinity;
  private queuedLine: { text: string; at: number } | null = null;

  private thinking = false;
  private nextThinkAt = 0;
  private wake = false;
  private nearbyCount = 0;
  private reflexes: Reflexes | null = null;
  private lastRepathAt = 0;

  private brainBusy: BrainQueryKind | null = null;
  private brainLastAt: Record<BrainQueryKind, number> = {
    reply: -Infinity,
    plan: -Infinity,
    decide: -Infinity,
  };
  private brainBackoffUntil = 0;
  private brainBackoffMs = BRAIN_BACKOFF_MS;
  /** Set when a brain query cannot work until someone fixes a grant. */
  private brainDisabled: string | null = null;

  private stats = {
    jevCalls: 0,
    jevFailures: 0,
    jevLatencyMs: 0,
    jevError: null as string | null,
    brainCalls: 0,
    brainFailures: 0,
    brainError: null as string | null,
  };

  private unsubscribe: () => void;

  constructor(
    persona: Persona,
    model: AgentModelName,
    readonly view: WorldView,
    private readonly services: AgentServices,
    spawnAt: { x: number; z: number },
  ) {
    this.id = persona.id;
    this.name = persona.name;
    this.persona = persona;
    this.model = model;
    this.userId = agentUserId(persona.name);
    this.sessionId = agentSessionId(persona.id);
    this.body = new Body(spawnAt, view.geometry, view.state().world);
    this.mind = initialMind(performance.now());
    this.unsubscribe = view.onChat((message) => this.hear(message));
  }

  get levelKey(): string {
    return this.view.levelKey;
  }

  dispose(): void {
    this.unsubscribe();
  }

  // ── Every frame: the body ──────────────────────────────────────────────

  /** Moves the body and returns a pose to publish, if one is due. */
  update(dt: number, now: number): EyePose | null {
    const world = this.view.state().world;
    this.followPartner(now, world);
    this.buildStep(now);
    this.body.step(dt, world);
    this.flushQueuedLine(now);

    if (this.mind.mode === "EXPLORE" && this.waypoint != null && !this.body.moving) {
      this.visited.push(this.waypoint);
      if (this.visited.length > 20) {
        this.visited.shift();
      }
      this.waypoint = null;
    }

    return this.sampler.sample(now, this.body.eyePose());
  }

  private followPartner(now: number, world: ReturnType<WorldView["state"]>["world"]): void {
    const partner = this.partnerPlayer();
    if (this.mind.mode !== "SOCIAL" || partner == null) {
      return;
    }
    const distance = this.body.distanceTo(partner);
    if (this.staying) {
      this.body.lookAt(partner);
      return;
    }
    if (distance > 5 && now - this.lastRepathAt > REPATH_MS) {
      this.lastRepathAt = now;
      this.body.goTo(world, partner, 3.5);
    } else if (distance <= 4) {
      this.body.stop();
    }
    this.body.lookAt(partner);
  }

  // ── Hearing ────────────────────────────────────────────────────────────

  private hear(message: HeardMessage): void {
    const now = performance.now();
    const own = message.sessionId === this.sessionId;
    if (!own && !this.canHear(message)) {
      return;
    }
    this.recentChat.push(message);
    if (this.recentChat.length > RECENT_CHAT) {
      this.recentChat.shift();
    }
    if (own) {
      return;
    }

    const partner = this.mind.partner;
    if (partner != null && partner.sessionId === message.sessionId) {
      this.addConversation(plainName(message.userId), message.text);
    }

    this.messageSerial++;
    this.pendingMessages.push({
      key: `m${this.messageSerial}`,
      sessionId: message.sessionId,
      userId: message.userId,
      isAgent: message.isAgent,
      mentionsName: message.text.toLowerCase().includes(this.name.toLowerCase()),
      receivedAt: now,
      message,
    });
    this.services.log(this, "heard", `${plainName(message.userId)}: ${message.text}`);
    this.wake = true;
  }

  private canHear(message: HeardMessage): boolean {
    if (message.x == null || message.z == null) {
      return true;
    }
    const radius = isShout(message.text) ? SHOUT_RADIUS : HEARING_RADIUS;
    return Math.hypot(message.x - this.body.x, message.z - this.body.z) <= radius;
  }

  private addConversation(speaker: string, text: string): void {
    this.conversation.push({ speaker, text });
    if (this.conversation.length > CONVERSATION_LINES) {
      this.conversation.shift();
    }
  }

  // ── Thinking: Jev, then the state machine ──────────────────────────────

  /** Called often by the host; decides for itself whether a tick is due. */
  async think(now: number): Promise<void> {
    if (this.thinking) {
      return;
    }
    this.checkWakeRange();
    if (!this.wake && now < this.nextThinkAt) {
      return;
    }
    this.wake = false;
    this.thinking = true;
    if (this.planWanted != null && this.canAsk("plan")) {
      const { near } = this.planWanted;
      this.planWanted = null;
      void this.requestPlan(near);
    }
    try {
      this.expirePending(now);
      const jev = this.services.jev();
      let reflexes: Reflexes | null = null;
      if (jev != null) {
        reflexes = await this.askJev(jev, now);
      }
      if (reflexes == null) {
        reflexes = this.heuristicReflexes();
      }
      this.reflexes = reflexes;
      this.decideAndAct(performance.now(), reflexes);
      this.nextThinkAt =
        performance.now() +
        (jev == null
          ? THINK_WITHOUT_JEV_MS
          : this.mind.mode === "IDLE"
            ? THINK_IDLE_MS
            : THINK_ACTIVE_MS);
    } finally {
      this.thinking = false;
    }
  }

  private checkWakeRange(): void {
    const close = this.view
      .roster()
      .filter(
        (player) =>
          player.sessionId !== this.sessionId &&
          !player.isAgent &&
          this.body.distanceTo(player) <= WAKE_RANGE,
      ).length;
    if (close > this.nearbyCount) {
      this.wake = true;
    }
    this.nearbyCount = close;
  }

  private expirePending(now: number): void {
    this.pendingMessages = this.pendingMessages.filter(
      (pending) => now - pending.receivedAt < PENDING_TTL_MS,
    );
  }

  private newestPending(): (PendingMessage & { message: HeardMessage }) | null {
    return this.pendingMessages[this.pendingMessages.length - 1] ?? null;
  }

  private async askJev(jev: JevClient, now: number): Promise<Reflexes | null> {
    const pending = this.newestPending();
    const partnerPlayer = this.partnerPlayer();
    const summary = summarise({
      self: {
        name: this.name,
        mode: this.mind.mode,
        modeAgeS: (now - this.mind.since) / 1000,
        goal: this.goal,
        building: this.planSummary(),
        stalledS: this.body.stalledFor,
        x: this.body.x,
        z: this.body.z,
        yaw: this.body.yaw,
      },
      now,
      players: this.others(),
      recentChat: this.recentChat,
      pending:
        pending == null
          ? null
          : { key: pending.key, message: pending.message, distance: this.distanceToMessage(pending.message) },
      partner: this.mind.partner?.userId ?? null,
      partnerLastHeardS:
        this.mind.partner != null ? Math.round((now - this.mind.lastHeardAt) / 1000) : null,
      cubes: this.view.state().cubes,
      ownUserId: this.userId,
    });
    const questions = questionsFor({
      mode: this.mind.mode,
      hasPending: pending != null,
      pendingFromAgent: pending?.isAgent ?? false,
      hasPartner: this.mind.partner != null && partnerPlayer != null,
      building: this.plan != null,
    });

    try {
      const result = await jev.ask(summary, questions, { user: this.sessionId });
      this.stats.jevCalls++;
      this.stats.jevLatencyMs = Math.round(result.latencyMs);
      this.stats.jevError = null;
      this.services.spent(result.cost);
      return readReflexes(result.answers);
    } catch (error) {
      this.stats.jevFailures++;
      const message = error instanceof Error ? error.message : String(error);
      this.stats.jevError = message;
      if (error instanceof JevError && (error.outOfCredits || error.unauthorised)) {
        this.services.jevFatal(message);
      }
      this.services.log(this, "error", `Jev: ${message}`);
      return null;
    }
  }

  /**
   * Reflexes without Jev: enough to answer someone who says your name, or
   * who walks right up and talks, and to keep wandering.
   */
  private heuristicReflexes(): Reflexes {
    const pending = this.newestPending();
    let addressed: number | null = null;
    if (pending != null) {
      const distance = this.distanceToMessage(pending.message);
      const text = pending.message.text.toLowerCase();
      // Naming someone else who is here means it is for them, however close I stand.
      const namesSomeoneElse = this.others().some((player) => {
        const name = plainName(player.userId).toLowerCase();
        return player.sessionId !== pending.sessionId && name.length > 1 && text.includes(name);
      });
      addressed = pending.mentionsName
        ? 0.95
        : namesSomeoneElse
          ? 0.1
          : !pending.isAgent && distance != null && distance < 6
            ? 0.75
            : 0.2;
    }
    return { ...NO_REFLEXES, addressedToMe: addressed, worthReplying: pending?.isAgent ? 0 : null };
  }

  private decideAndAct(now: number, reflexes: Reflexes): void {
    const before = this.mind.mode;
    const situation = this.situation(now, reflexes);
    const { state, intents } = decide(this.mind, situation);
    this.mind = state;
    if (state.mode !== before) {
      this.services.log(this, "mode", `${before} → ${state.mode}`);
      if (before === "EXPLORE" || before === "SOCIAL") {
        this.body.stop();
        this.waypoint = null;
      }
    }
    for (const intent of intents) {
      this.carryOut(intent, now, situation);
    }
  }

  private situation(now: number, reflexes: Reflexes | null): Situation {
    const pending = this.newestPending();
    const partner = this.partnerPlayer();
    const humans = this.others()
      .filter((player) => !player.isAgent)
      .map((player) => ({ player, distance: this.body.distanceTo(player) }))
      .sort((a, b) => a.distance - b.distance);
    const nearest = humans[0];
    this.agentTurnTimes = this.agentTurnTimes.filter((at) => now - at < 60000);

    return {
      now,
      reflexes,
      pending: pending == null ? null : { ...pending },
      partnerDistance: partner != null ? this.body.distanceTo(partner) : null,
      nearbyHuman:
        nearest == null
          ? null
          : {
              sessionId: nearest.player.sessionId,
              userId: nearest.player.userId,
              distance: nearest.distance,
              greetedRecently:
                now - (this.greeted.get(nearest.player.userId) ?? -Infinity) < GREET_EVERY_MS,
            },
      hasPlan: this.plan != null,
      planComplete: this.plan != null && this.placed >= this.plan.cubes.length,
      hasWaypoint: this.waypoint != null && this.body.moving,
      agentTurns: this.agentTurnTimes.length,
    };
  }

  private carryOut(intent: Intent, now: number, situation: Situation): void {
    const world = this.view.state().world;
    switch (intent.type) {
      case "reply":
        void this.reply(intent.messageKey, null);
        break;
      case "ignore":
        this.dropPending(intent.messageKey);
        break;
      case "greet": {
        const player = this.view.roster().find((candidate) => candidate.sessionId === intent.sessionId);
        if (player != null) {
          this.greeted.set(player.userId, now);
          void this.reply(null, player);
        }
        break;
      }
      case "approach": {
        const player = this.view.roster().find((candidate) => candidate.sessionId === intent.sessionId);
        if (player != null && !this.staying && now - this.lastRepathAt > REPATH_MS) {
          this.lastRepathAt = now;
          this.body.goTo(world, player, 3.5);
        }
        break;
      }
      case "face": {
        const player = this.view.roster().find((candidate) => candidate.sessionId === intent.sessionId);
        this.body.lookAt(player ?? null);
        break;
      }
      case "escalate":
        if (intent.topic === "answer") {
          void this.escalateAnswer(intent.messageKey);
        } else {
          void this.escalateMode(situation);
        }
        break;
      case "chooseGoal":
        void this.chooseGoal();
        break;
      case "wander":
        this.wander(world);
        break;
      case "build":
        // Placement happens every frame in buildStep; nothing to start here.
        break;
      case "abandonPlan":
        this.services.log(this, "build", `Gave up on ${this.plan?.title ?? "the build"}`);
        this.plan = null;
        this.goal = null;
        break;
      case "stand":
        this.body.stop();
        break;
    }
  }

  // ── Layer 1 behaviours ─────────────────────────────────────────────────

  /**
   * Somewhere new to walk to: a handful of candidates around, preferring
   * ones far from where this agent has recently been, and never the sea.
   */
  private wander(world: ReturnType<WorldView["state"]>["world"]): void {
    const geometry = this.view.geometry;
    let best: { x: number; z: number; score: number } | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = geometry.halfSize != null ? 3 + Math.random() * (geometry.halfSize - 4) : 12 + Math.random() * 28;
      const x = this.body.x + Math.cos(angle) * radius;
      const z = this.body.z + Math.sin(angle) * radius;
      if (geometry.halfSize != null && (Math.abs(x) > geometry.halfSize - 2 || Math.abs(z) > geometry.halfSize - 2)) {
        continue;
      }
      const ground = world.terrainAt(x, z);
      if (geometry.seaLevel != null && ground < geometry.seaLevel + 0.5) {
        continue;
      }
      const novelty = Math.min(
        40,
        ...this.visited.map((point) => Math.hypot(point.x - x, point.z - z)),
      );
      // Stay within reach of home in the open world, so agents do not drift off forever.
      const [homeX, homeZ] = this.persona.home;
      const homeDistance = Math.hypot(x - homeX, z - homeZ);
      const score = novelty - Math.max(0, homeDistance - 60) * 0.8 - Math.abs(ground - this.body.feetY) * 0.3;
      if (best == null || score > best.score) {
        best = { x, z, score };
      }
    }
    if (best != null && this.body.goTo(world, best)) {
      this.waypoint = { x: best.x, z: best.z };
    }
  }

  /** Places the next cube of the plan when in reach and the rate allows. */
  private buildStep(now: number): void {
    const plan = this.plan;
    if (plan == null || this.mind.mode !== "BUILD" || this.placed >= plan.cubes.length) {
      return;
    }
    const world = this.view.state().world;
    const cube = plan.cubes[this.placed];
    const centre = cubeCentre(world, plan.site, cube);

    // Someone already filled this cell — a human helping, most likely. Skip it.
    if (hasCube(world.voxels, cellOf(centre.x), cellOf(centre.y), cellOf(centre.z))) {
      this.placed++;
      return;
    }

    const standAt = this.standingSpot(plan, centre);
    const distance = Math.hypot(centre.x - this.body.x, centre.z - this.body.z);
    const insideFootprint =
      this.body.x > plan.site.cellX - 0.4 &&
      this.body.x < plan.site.cellX + plan.site.size + 0.4 &&
      this.body.z > plan.site.cellZ - 0.4 &&
      this.body.z < plan.site.cellZ + plan.site.size + 0.4;

    if (distance > BUILD_REACH || insideFootprint) {
      if (!this.body.moving || now - this.lastRepathAt > 4000) {
        this.lastRepathAt = now;
        const routed = this.body.goTo(world, standAt, 0.8);
        const stalled = this.body.stalledFor > 4;
        this.buildRouteFailures = routed && !stalled ? 0 : this.buildRouteFailures + 1;
        if (this.buildRouteFailures >= 3) {
          // Game logic's own "stuck", for when Jev is not there to say so.
          this.services.log(this, "build", `Cannot reach the site for ${plan.title}; giving up.`);
          this.plan = null;
          this.goal = null;
          this.buildRouteFailures = 0;
        }
      }
      return;
    }

    this.body.stop();
    this.body.lookAt(centre);
    this.body.yaw = yawTowards(this.body, centre);
    if (now < this.nextCubeAt) {
      return;
    }
    this.nextCubeAt = now + 60000 / CUBES_PER_MINUTE;
    this.services.placeCube(this, centre, cube.color);
    this.placed++;
    if (this.placed >= plan.cubes.length) {
      this.services.log(this, "build", `Finished ${plan.title}`);
      this.addConversation(this.name, `(finished building ${plan.title})`);
      this.goal = null;
    }
  }

  /** A spot just outside the site, on the side nearest the cube. */
  private standingSpot(plan: BuildPlan, centre: { x: number; z: number }): { x: number; z: number } {
    const { cellX, cellZ, size } = plan.site;
    const midX = cellX + size / 2;
    const midZ = cellZ + size / 2;
    const dx = centre.x - midX;
    const dz = centre.z - midZ;
    if (Math.abs(dx) > Math.abs(dz)) {
      return { x: dx > 0 ? cellX + size + 1.2 : cellX - 1.2, z: centre.z };
    }
    return { x: centre.x, z: dz > 0 ? cellZ + size + 1.2 : cellZ - 1.2 };
  }

  // ── Layer 3: the brain queries ─────────────────────────────────────────

  /**
   * Runs one brain query, within the budgets: one in flight per agent, a
   * minimum gap per kind, and a back-off after failures. Returns the raw
   * text, or null when it did not run or failed.
   */
  /** Whether a query of this kind may run now, within the budgets. */
  private canAsk(kind: BrainQueryKind): boolean {
    const now = performance.now();
    return (
      this.brainDisabled == null &&
      this.brainBusy == null &&
      now >= this.brainBackoffUntil &&
      now - this.brainLastAt[kind] >= MIN_GAP_MS[kind]
    );
  }

  private async ask(kind: BrainQueryKind, prompt: string): Promise<string | null> {
    const now = performance.now();
    if (!this.canAsk(kind)) {
      return null;
    }
    this.brainBusy = kind;
    this.brainLastAt[kind] = now;
    this.stats.brainCalls++;
    try {
      const text = await foundryModelCall(this.model, this.persona.persona, kind)(prompt);
      this.brainBackoffMs = BRAIN_BACKOFF_MS;
      this.stats.brainError = null;
      if (text === "") {
        this.stats.brainFailures++;
        this.services.log(this, "llm", `${kind}: unanswered (empty reply)`);
        return null;
      }
      return text;
    } catch (error) {
      this.stats.brainFailures++;
      const message = error instanceof Error ? error.message : String(error);
      this.stats.brainError = message;
      this.services.log(this, "error", message);
      if (error instanceof BrainCallError && error.permissionDenied) {
        // Retrying will not grant a permission; stay quiet until fixed.
        this.brainDisabled = message;
      } else {
        this.brainBackoffUntil = performance.now() + this.brainBackoffMs;
        this.brainBackoffMs = Math.min(BRAIN_BACKOFF_MAX_MS, this.brainBackoffMs * 2);
      }
      return null;
    } finally {
      this.brainBusy = null;
    }
  }

  /**
   * Speaks: either answering pending messages (`messageKey` is the one the
   * reflexes picked) or greeting someone unprompted (`greet`).
   */
  private async reply(messageKey: string | null, greet: WorldPlayer | null): Promise<void> {
    const now = performance.now();
    const answerable = this.pendingMessages.slice(-3);
    const messages: PromptMessage[] =
      greet != null
        ? []
        : answerable.map((pending) => ({
            key: pending.key,
            from: plainName(pending.userId),
            fromKind: pending.isAgent ? "ai" : "human",
            text: pending.message.text,
            secondsAgo: (now - pending.receivedAt) / 1000,
            distance: this.distanceToMessage(pending.message),
          }));
    if (greet == null && messages.length === 0) {
      return;
    }

    const speakers = new Set(answerable.map((pending) => pending.userId));
    if (greet != null) {
      speakers.add(greet.userId);
    }
    const memories = [...speakers].flatMap((userId) =>
      recall(this.id, plainName(userId), 3).map((text) => `${plainName(userId)}: ${text}`),
    );

    const prompt = buildReplyPrompt({
      agentName: this.name,
      goal: this.goal,
      building: this.plan?.title ?? null,
      messages,
      greet: greet != null ? plainName(greet.userId) : null,
      people: this.others()
        .slice(0, 6)
        .map((player) => ({
          name: plainName(player.userId),
          kind: player.isAgent ? "ai" : "human",
          distance: this.body.distanceTo(player),
        })),
      conversation: this.conversation,
      memories,
      actions: this.replyActions(),
    });

    const text = await this.ask("reply", prompt);
    if (text == null) {
      return;
    }
    const keys = messages.map((message) => message.key);
    const reply = parseReply(text, keys, this.replyActions());
    if (reply == null) {
      this.services.log(this, "llm", `reply discarded: ${text.slice(0, 120)}`);
      if (messageKey != null) {
        this.dropPending(messageKey);
      }
      return;
    }

    const answered = answerable.find((pending) => pending.key === reply.replyTo);
    if (answered != null) {
      // Everything that speaker had said up to now is dealt with.
      this.pendingMessages = this.pendingMessages.filter(
        (pending) => !(pending.userId === answered.userId && pending.receivedAt <= answered.receivedAt),
      );
      if (answered.isAgent) {
        this.agentTurnTimes.push(performance.now());
      }
      if (reply.remember != null) {
        remember(this.id, plainName(answered.userId), reply.remember);
        this.services.log(this, "llm", `remembered about ${plainName(answered.userId)}: ${reply.remember}`);
      }
      if (this.mind.partner == null || this.mind.partner.sessionId !== answered.sessionId) {
        this.addConversation(plainName(answered.userId), answered.message.text);
      }
    } else if (messageKey != null) {
      this.dropPending(messageKey);
    }

    if (await this.isInappropriate(reply.say)) {
      this.services.log(this, "error", `withheld by moderation: ${reply.say}`);
      return;
    }
    this.addConversation(this.name, reply.say);
    this.queuedLine = { text: reply.say, at: performance.now() };
    this.flushQueuedLine(performance.now());

    const speaker =
      answered != null ? { sessionId: answered.sessionId, userId: answered.userId } : greet;
    if (reply.action !== "none") {
      this.services.log(
        this,
        "llm",
        `action: ${reply.action}${reply.build != null ? ` (${reply.build})` : ""}`,
      );
      await this.act(reply.action, reply.build, speaker);
    }
  }

  /** What a reply may ask the game to do, right now, in this room. */
  private replyActions(): ReplyAction[] {
    const actions: ReplyAction[] = ["none", "follow", "stay", "explore"];
    if (this.view.geometry.buildable) {
      actions.push("build");
    }
    if (this.plan != null) {
      actions.push("stop_building");
    }
    return actions;
  }

  /**
   * Carries out what the model said it would do.
   *
   * The model only names an action from the offered list; everything about
   * *how* — where to stand, what counts as following, which site to build
   * on — is still game logic.
   */
  private async act(
    action: ReplyAction,
    build: string | null,
    speaker: { sessionId: string; userId: string } | null,
  ): Promise<void> {
    const now = performance.now();
    switch (action) {
      case "none":
        return;
      case "follow":
        if (speaker == null) {
          return;
        }
        this.staying = false;
        this.mind = {
          ...this.mind,
          mode: "SOCIAL",
          since: now,
          partner: { sessionId: speaker.sessionId, userId: speaker.userId },
          lastHeardAt: now,
          following: true,
        };
        return;
      case "stay":
        this.staying = true;
        this.mind = { ...this.mind, following: false };
        this.body.stop();
        return;
      case "explore":
        this.staying = false;
        this.body.stop();
        this.waypoint = null;
        this.mind = { ...this.mind, mode: "EXPLORE", since: now, partner: null, following: false };
        return;
      case "stop_building":
        if (this.plan != null) {
          this.services.log(this, "build", `Stopped building ${this.plan.title}`);
        }
        this.plan = null;
        this.goal = null;
        if (this.mind.mode === "BUILD") {
          this.mind = { ...this.mind, mode: "IDLE", since: now };
        }
        return;
      case "build":
        this.staying = false;
        this.plan = null;
        this.goal = `build ${build ?? "something small"}`;
        this.mind = { ...this.mind, following: false };
        // Near whoever asked, so they can watch it go up.
        await this.requestPlan(speaker);
        return;
    }
  }

  /** Jev's pre-publish check. Without Jev the brief's own rules have to do. */
  private async isInappropriate(text: string): Promise<boolean> {
    const jev = this.services.jev();
    if (jev == null) {
      return false;
    }
    try {
      const result = await jev.ask({ line: text, speaker: this.name }, MODERATION_QUESTIONS, {
        user: this.sessionId,
      });
      this.services.spent(result.cost);
      return (noul(result.answers, "is_inappropriate") ?? 0) > MODERATION_THRESHOLD;
    } catch {
      return false;
    }
  }

  /** Speaks the queued line once the previous bubble has cleared. */
  private flushQueuedLine(now: number): void {
    const queued = this.queuedLine;
    if (queued == null) {
      return;
    }
    if (now - queued.at > SAY_QUEUE_TTL_MS) {
      this.queuedLine = null;
      return;
    }
    const unlockAt =
      this.lastSaid == null ? -Infinity : this.lastSaidAt + bubbleDurationMs(this.lastSaid) + SAY_GAP_MS;
    if (now < unlockAt) {
      return;
    }
    this.queuedLine = null;
    this.lastSaid = queued.text;
    this.lastSaidAt = now;
    this.services.log(this, "said", queued.text);
    void this.services.publishChat(this, queued.text).catch((error: unknown) => {
      this.services.log(this, "error", `chat: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async escalateAnswer(messageKey: string): Promise<void> {
    const pending = this.pendingMessages.find((candidate) => candidate.key === messageKey);
    if (pending == null) {
      return;
    }
    const prompt = buildDecidePrompt({
      agentName: this.name,
      question: `Should you answer ${plainName(pending.userId)}?`,
      situation: [
        `${plainName(pending.userId)} said, ${Math.round(this.distanceToMessage(pending.message) ?? 0)} m from you: "${pending.message.text}"`,
        ...this.situationLines(),
      ],
      options: ANSWER_OPTIONS,
    });
    const text = await this.ask("decide", prompt);
    const decision = text == null ? null : parseDecide(text, ANSWER_OPTIONS.map((option) => option.key));
    this.services.log(this, "llm", `answer ${plainName(pending.userId)}? → ${decision?.choice ?? "no answer (ignore)"}`);
    if (decision?.choice === "answer") {
      this.mind = {
        ...this.mind,
        partner: { sessionId: pending.sessionId, userId: pending.userId },
        lastHeardAt: performance.now(),
        mode: "SOCIAL",
        since: performance.now(),
      };
      await this.reply(messageKey, null);
    } else {
      this.dropPending(messageKey);
    }
  }

  private async escalateMode(situation: Situation): Promise<void> {
    const options: DecideOption[] = PRIMARY_MODES.map((mode) => ({
      key: mode,
      label: {
        IDLE: "Rest here for a while and watch.",
        EXPLORE: "Wander off somewhere new.",
        SOCIAL: "Go and talk to the nearest person.",
        BUILD: this.plan != null ? `Carry on building ${this.plan.title}.` : "Start building something.",
        REACTING: "",
      }[mode],
    }));
    const prompt = buildDecidePrompt({
      agentName: this.name,
      question: "What do you do next?",
      situation: this.situationLines(),
      options,
    });
    const text = await this.ask("decide", prompt);
    if (text == null) {
      return;
    }
    const decision = parseDecide(text, PRIMARY_MODES);
    if (decision == null) {
      return;
    }
    this.services.log(this, "llm", `next: ${decision.choice} — ${decision.why}`);
    const intents: Intent[] = [];
    this.mind = applyMode(this.mind, decision.choice as Mode, { ...situation, now: performance.now() }, intents);
    for (const intent of intents) {
      this.carryOut(intent, performance.now(), situation);
    }
  }

  /** Picks a goal from options built from the persona and the moment. */
  private async chooseGoal(): Promise<void> {
    const partner = this.mind.partner;
    const lastAsk =
      partner != null
        ? [...this.recentChat].reverse().find((message) => message.sessionId === partner.sessionId)
        : undefined;
    const options: DecideOption[] = [];
    if (partner != null) {
      options.push({
        key: "help",
        label: `Build what ${plainName(partner.userId)} asked for, next to them${lastAsk != null ? ` ("${lastAsk.text}")` : ""}.`,
      });
    }
    if (this.view.geometry.buildable) {
      this.persona.interests.forEach((interest, index) => {
        options.push({ key: `build-${index + 1}`, label: `Build ${interest} somewhere nearby.` });
      });
    } else {
      // Nothing may be built in this room; saying so beats a plan nobody can place.
      options.length = 0;
    }
    if (options.length === 0) {
      this.services.log(this, "llm", "goal: nothing can be built in this room");
      return;
    }
    options.push({ key: "explore", label: "Nothing to build right now; go and explore instead." });

    const prompt = buildDecidePrompt({
      agentName: this.name,
      question: "What will you do next?",
      situation: this.situationLines(),
      options,
    });
    const text = await this.ask("decide", prompt);
    const decision = text == null ? null : parseDecide(text, options.map((option) => option.key));
    if (decision == null || decision.choice === "explore") {
      this.services.log(this, "llm", `goal: explore${decision != null ? ` — ${decision.why}` : ""}`);
      return;
    }

    if (decision.choice === "help" && partner != null) {
      this.goal = `help ${plainName(partner.userId)} build${lastAsk != null ? ` what they asked for: "${lastAsk.text}"` : " something"}`;
    } else {
      const index = Number(decision.choice.replace("build-", "")) - 1;
      this.goal = `build ${this.persona.interests[index] ?? "something small"}`;
    }
    this.services.log(this, "llm", `goal: ${this.goal} — ${decision.why}`);
    // The plan gap is long; wait for the decide call to finish first.
    await this.requestPlan(decision.choice === "help" ? partner : null);
  }

  private async requestPlan(near: { sessionId: string } | null): Promise<void> {
    const goal = this.goal;
    if (goal == null) {
      return;
    }
    if (!this.canAsk("plan")) {
      // Busy, or planned very recently: plan as soon as a query may run.
      this.planWanted = { near };
      this.services.log(this, "build", `Will plan "${goal}" in a moment`);
      return;
    }
    const state = this.view.state();
    const anchorPlayer = near != null ? this.view.roster().find((player) => player.sessionId === near.sessionId) : null;
    const around = anchorPlayer ?? { x: this.body.x, z: this.body.z };
    const people = this.others();
    const sites = findBuildSites(state.world, this.view.geometry, around, 4, (centre) => {
      const nearest = people
        .map((player) => ({ player, distance: Math.hypot(player.x - centre.x, player.z - centre.z) }))
        .sort((a, b) => a.distance - b.distance)[0];
      return nearest != null && nearest.distance < 25
        ? `${Math.round(nearest.distance)} m from ${plainName(nearest.player.userId)}`
        : "open ground";
    });
    if (sites.length === 0) {
      this.services.log(this, "build", "No free, flat ground nearby to build on.");
      this.goal = null;
      return;
    }
    const prompt = buildPlanPrompt({
      agentName: this.name,
      goal,
      sites,
      nearbyColors: nearbyColours(state.cubes, around.x, around.z),
      maxCubes: MAX_PLAN_CUBES,
    });
    const text = await this.ask("plan", prompt);
    const plan = text == null ? null : parsePlan(text, sites, MAX_PLAN_CUBES);
    if (plan == null) {
      this.services.log(this, "llm", `plan discarded${text != null ? `: ${text.slice(0, 120)}` : ""}`);
      this.goal = null;
      return;
    }
    this.plan = plan;
    this.placed = 0;
    this.buildRouteFailures = 0;
    this.services.log(
      this,
      "build",
      `Plan: ${plan.title}, ${plan.cubes.length} cubes on site ${plan.site.key}` +
        (plan.discarded > 0 ? ` (${plan.discarded} invalid cubes dropped)` : ""),
    );
    const now = performance.now();
    this.mind = { ...this.mind, mode: "BUILD", since: now, following: false };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private dropPending(messageKey: string): void {
    this.pendingMessages = this.pendingMessages.filter((pending) => pending.key !== messageKey);
  }

  private others(): WorldPlayer[] {
    return this.view
      .roster()
      .filter((player) => player.sessionId !== this.sessionId)
      .sort((a, b) => this.body.distanceTo(a) - this.body.distanceTo(b));
  }

  private partnerPlayer(): WorldPlayer | null {
    const partner = this.mind.partner;
    if (partner == null) {
      return null;
    }
    return this.view.roster().find((player) => player.sessionId === partner.sessionId) ?? null;
  }

  private distanceToMessage(message: HeardMessage): number | null {
    if (message.x == null || message.z == null) {
      return null;
    }
    return Math.hypot(message.x - this.body.x, message.z - this.body.z);
  }

  private planSummary(): { title: string; placed: number; total: number } | null {
    return this.plan == null
      ? null
      : { title: this.plan.title, placed: this.placed, total: this.plan.cubes.length };
  }

  private situationLines(): string[] {
    const lines: string[] = [];
    lines.push(`You are ${this.mind.mode.toLowerCase()}.`);
    if (this.goal != null) {
      lines.push(`Your goal: ${this.goal}.`);
    }
    const plan = this.planSummary();
    if (plan != null) {
      lines.push(`Building ${plan.title}: ${plan.placed} of ${plan.total} cubes placed.`);
    }
    const people = this.others().slice(0, 4);
    lines.push(
      people.length === 0
        ? "Nobody is around."
        : `Nearby: ${people
            .map((player) => `${plainName(player.userId)}${player.isAgent ? " (AI)" : ""} ${Math.round(this.body.distanceTo(player))} m`)
            .join(", ")}.`,
    );
    for (const line of this.conversation.slice(-4)) {
      lines.push(`${line.speaker} said: "${line.text}"`);
    }
    return lines;
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      name: this.name,
      userId: this.userId,
      levelKey: this.levelKey,
      model: this.model,
      mode: this.mind.mode,
      goal: this.goal,
      partner: this.mind.partner != null ? plainName(this.mind.partner.userId) : null,
      plan: this.planSummary(),
      position: [
        Math.round(this.body.x * 10) / 10,
        Math.round(this.body.feetY * 10) / 10,
        Math.round(this.body.z * 10) / 10,
      ],
      lastSaid: this.lastSaid,
      reflexes: this.reflexes,
      jev: {
        calls: this.stats.jevCalls,
        failures: this.stats.jevFailures,
        lastLatencyMs: this.stats.jevLatencyMs,
        error: this.stats.jevError,
      },
      brain: {
        calls: this.stats.brainCalls,
        failures: this.stats.brainFailures,
        busy: this.brainBusy,
        error: this.brainDisabled ?? this.stats.brainError,
      },
    };
  }
}
