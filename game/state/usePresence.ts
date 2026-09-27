import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "@/foundry/errors";
import {
  PRESENCE_SCHEMA_VERSION,
  type PresenceCursor,
  type PresenceRecord,
  isPresenceEnabled,
  presenceTailCursor,
  publishPresence,
  readPresence,
} from "@/foundry/streams/presence";
import { usePolling } from "@/game/state/usePolling";
import { angleDelta } from "@/shared/angles";
import { RollingPercentile } from "@/shared/percentile";

/** A pose sampled from the local camera. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** One received pose, stamped on the local clock. */
export interface Sample {
  /** Local playback time this sample should be rendered at. */
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Horizontal velocity in m/s, when the publisher sent it. */
  vx?: number;
  vz?: number;
}

/** A locally taken sample waiting to be published. */
interface OutboxSample {
  at: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vz: number;
}

/** Everything known about one remote player, including their trajectory. */
export interface PlayerTrack {
  sessionId: string;
  userId: string;
  levelKey: string;
  weapon: string;
  lastSeen: number;
  /** When an update for this player last arrived, for cadence measurement. */
  lastArrivalAt: number;
  /** Publisher clock → local clock offset, min-filtered. */
  offset: number | null;
  samples: Sample[];
}

/** Render-facing summary; the smooth pose comes from the track buffer. */
export interface RemotePlayer {
  sessionId: string;
  userId: string;
  levelKey: string;
  weapon: string;
  position: [number, number, number];
  yaw: number;
}

interface Options {
  levelKey: string;
  sessionId: string;
  userId: string;
  weapon: string;
}

/**
 * How often the sampler *considers* taking a sample. Whether it actually keeps
 * one is decided adaptively: densely through turns, sparsely in a straight
 * line, which spends the byte budget where the trajectory needs detail.
 */
const SAMPLE_INTERVAL_MS = 50;
/**
 * Keyframe thresholds. Measured publish round-trip is ~40 ms, so samples are
 * cheap and it is worth taking them often: a denser trajectory means shorter
 * spans to interpolate across and less reliance on prediction.
 */
const KEYFRAME_DISTANCE = 0.2;
/** ...or turned this much (radians). */
const KEYFRAME_TURN = 0.08;
/** ...or changed heading this much (radians) while moving. */
const KEYFRAME_HEADING = 0.18;
/** While moving, never go longer than this without a sample. */
const KEYFRAME_MAX_GAP_MS = 150;
/**
 * One request carries every sample taken since the last one. This also floors
 * the arrival gap: nobody can hear from us more often than we send.
 */
const PUBLISH_INTERVAL_MS = 100;
/** Assumed arrival cadence until the subscription has been measured. */
const INITIAL_GAP_MS = 250;
/** How often the roster is reconciled into React state. */
const ROSTER_REFRESH_MS = 400;
/** After a failure, wait this multiple longer, up to the cap, then recover. */
const BACKOFF_MAX_MS = 2000;
/** Never send more than this per batch, however long a hitch lasted. */
const MAX_SAMPLES_PER_BATCH = 8;
/** Send something even when standing still, so others know we are alive. */
const HEARTBEAT_MS = 2000;
/** Movement below this (metres / radians) does not need a new sample. */
const MOVE_EPSILON = 0.05;
const TURN_EPSILON = 0.02;
/** Players unheard from for this long are dropped from the roster. */
const STALE_AFTER_MS = 10000;
/** Keep a little history behind the playback head for interpolation. */
const SAMPLE_HISTORY_MS = 3000;
/**
 * Playback sits this fraction of the 90th percentile arrival gap behind real
 * time. Deliberately well under one full gap: the buffer only has to absorb
 * *jitter*, because dead reckoning covers the space between updates. Sizing it
 * at a whole interval (as pure interpolation requires) would add most of a
 * second of lag on a slow index — delay we inflict on ourselves, on top of
 * whatever the pipeline already costs.
 */
const PLAYBACK_DELAY_FACTOR = 0.35;
const PLAYBACK_DELAY_MIN_MS = 120;
const PLAYBACK_DELAY_MAX_MS = 700;
/** Headroom added on top of measured lateness, so the buffer is not marginal. */
const LATENESS_MARGIN_MS = 40;
/** Arrival gaps kept for the percentile estimate. */
const GAP_WINDOW = 24;
/** How often the stream is polled for everyone else's poses, in ms. */
const POLL_INTERVAL_MS = 150;

/**
 * State of the read loop, surfaced on the HUD so a feed that has stopped is
 * visible rather than silent.
 *
 * "connecting" until the first poll returns, "retrying" after one has failed,
 * and "disabled" when the stream RID has been blanked out.
 */
export type PresenceLink = "connecting" | "live" | "retrying" | "disabled";

/**
 * Broadcasts this player's pose to the presence stream and keeps a trajectory
 * buffer for everyone else.
 *
 * Poses are sampled adaptively (denser through turns) and published in batches
 * every 100 ms. They are read back by tailing the same stream from its end, so
 * no history is ever replayed: a pose from before you joined is of no interest
 * to anyone, and the roster evicts whoever stops publishing.
 */
export function usePresence({ levelKey, sessionId, userId, weapon }: Options): {
  players: RemotePlayer[];
  tracksRef: React.MutableRefObject<Map<string, PlayerTrack>>;
  /** How far behind real time avatars should be rendered, in ms. */
  playbackDelayRef: React.MutableRefObject<number>;
  reportPose: (pose: Pose) => void;
  enabled: boolean;
  /** Subscription lifecycle, so a closed link is visible rather than silent. */
  link: PresenceLink;
  stats: {
    sent: number;
    error: string | null;
    /** Measured gap between update arrivals, and the buffer sized from it. */
    gapMs: number;
    delayMs: number;
    /**
     * Estimated one-way pipeline latency: publish → index → subscription,
     * from the min-filtered clock offset. Distinguishes delay the platform
     * costs us from delay we add ourselves.
     */
    lagMs: number;
    /** Round-trip time of a publish call, smoothed. */
    publishMs: number;
  };
} {
  const [players, setPlayers] = useState<RemotePlayer[]>([]);
  const [stats, setStats] = useState<{
    sent: number;
    error: string | null;
    gapMs: number;
    delayMs: number;
    lagMs: number;
    publishMs: number;
  }>({ sent: 0, error: null, gapMs: 0, delayMs: 0, lagMs: 0, publishMs: 0 });
  const [link, setLink] = useState<PresenceLink>(isPresenceEnabled() ? "connecting" : "disabled");
  const cursorRef = useRef<PresenceCursor | null>(null);
  /** Round-trip time of the last publish, smoothed. */
  const publishMsRef = useRef(0);
  const sentRef = useRef(0);
  const errorRef = useRef<string | null>(null);
  const poseRef = useRef<Pose | null>(null);
  const outboxRef = useRef<OutboxSample[]>([]);
  const lastSampledRef = useRef<OutboxSample | null>(null);
  const lastPublishedAtRef = useRef(0);
  const tracksRef = useRef(new Map<string, PlayerTrack>());
  const playbackDelayRef = useRef(PLAYBACK_DELAY_MIN_MS * PLAYBACK_DELAY_FACTOR);
  /** How long between updates from the same player, at the 90th percentile. */
  const arrivalGapRef = useRef(new RollingPercentile(GAP_WINDOW, 0.9, INITIAL_GAP_MS));
  /**
   * How far *past* an arriving sample the playback head already was. Positive
   * values mean the buffer was too shallow to interpolate that sample, so we
   * had to predict instead. Sizing the buffer to cover this is what stops the
   * walk-pause-walk pattern.
   */
  const latenessRef = useRef(new RollingPercentile(GAP_WINDOW, 0.9, 0));
  // Skip publishing until this timestamp after a failure, so a throttled or
  // broken stream degrades gracefully instead of hammering.
  const backoffRef = useRef({ until: 0, delay: 0 });
  // Kept in refs so the publish loop never restarts mid-stride.
  const contextRef = useRef({ levelKey, weapon, userId, sessionId });
  contextRef.current = { levelKey, weapon, userId, sessionId };

  /** Called every frame from inside the Canvas; cheap, no re-render. */
  const reportPose = useCallback((pose: Pose) => {
    poseRef.current = pose;
  }, []);

  /**
   * Buffer depth covers two things: the spread in arrival times, and how late
   * samples land relative to the playback head. The second term is what keeps
   * there being something ahead to interpolate toward.
   */
  const recomputeDelay = useCallback(() => {
    const fromGaps = arrivalGapRef.current.value * PLAYBACK_DELAY_FACTOR;
    const fromLateness = latenessRef.current.value;
    playbackDelayRef.current = Math.min(
      PLAYBACK_DELAY_MAX_MS,
      Math.max(PLAYBACK_DELAY_MIN_MS, fromGaps + fromLateness + LATENESS_MARGIN_MS),
    );
  }, []);

  /**
   * Records how long it has been since the *same player* last updated, and
   * sizes the jitter buffer from the spread.
   *
   * Measuring per player matters: with several players in the room, updates
   * interleave, so a global inter-arrival time looks far shorter than the
   * cadence any single avatar actually receives — which would size the buffer
   * too small and leave every avatar starving between its own updates.
   */
  const noteGap = useCallback(
    (gapMs: number) => {
      // 90th percentile: one slow batch should widen the buffer, but a run of
      // fast ones should not shrink it below the real jitter.
      arrivalGapRef.current.add(gapMs, { max: 4000 });
      recomputeDelay();
    },
    [recomputeDelay],
  );

  /**
   * Records how far *past* an arriving sample the playback head already was.
   *
   * Sender timestamps are mapped onto our clock with the minimum observed
   * latency, so any sample that took longer than the best case lands with a
   * timestamp already behind the playback head — there is nothing ahead to
   * interpolate toward, and the avatar coasts on prediction until the next one
   * arrives. That is the walk-pause-walk pattern. Measuring the lateness and
   * folding it into the buffer removes the cause.
   */
  const noteLateness = useCallback(
    (lateness: number) => {
      latenessRef.current.add(lateness, { min: 0, max: 1500 });
      recomputeDelay();
    },
    [recomputeDelay],
  );

  /** Folds incoming poses into the per-player trajectory buffers. */
  const applyRecords = useCallback(
    (records: PresenceRecord[], now: number): void => {
      const tracks = tracksRef.current;

      for (const record of records) {
        if (record.sessionId === sessionId) {
          continue;
        }
        if (record.state === "left") {
          tracks.delete(record.sessionId);
          continue;
        }

        let track = tracks.get(record.sessionId);
        if (track == null) {
          track = {
            sessionId: record.sessionId,
            userId: record.userId,
            levelKey: record.levelKey,
            weapon: record.weapon ?? "select",
            lastSeen: now,
            lastArrivalAt: 0,
            offset: null,
            samples: [],
          };
          tracks.set(record.sessionId, track);
        }

        // Cadence is measured per player, not globally — and only while they
        // are actually moving. An idle player publishes a heartbeat every two
        // seconds, and letting those gaps into the estimate would size the
        // buffer for a cadence that only applies when nothing is happening.
        const speed = Math.hypot(record.vx ?? 0, record.vz ?? 0);
        if (speed > 0.15 && track.lastArrivalAt > 0 && now > track.lastArrivalAt) {
          noteGap(now - track.lastArrivalAt);
        }
        track.lastArrivalAt = now;

        // Map the publisher's clock onto ours. The minimum observed delta is
        // the least-delayed sample seen, which is the best skew estimate; let
        // it drift upward slowly so genuine clock drift is followed.
        const observed = now - record.timestamp;
        track.offset = track.offset == null ? observed : Math.min(observed, track.offset + 40);

        track.userId = record.userId;
        track.levelKey = record.levelKey;
        track.weapon = record.weapon ?? track.weapon;
        track.lastSeen = now;

        if (record.x == null || record.z == null) {
          continue;
        }

        // Delivery is at-least-once, so the same pose can arrive twice. Drop
        // repeats rather than inserting a zero-length spline segment.
        const sampleTime = record.timestamp + track.offset;
        const recent = track.samples.slice(-12);
        if (recent.some((sample) => sample.t === sampleTime)) {
          continue;
        }

        // How far past this sample the playback head already was. Anything
        // above zero means we had to predict rather than interpolate.
        noteLateness(now - playbackDelayRef.current - sampleTime);

        track.samples.push({
          t: sampleTime,
          x: record.x,
          y: record.y ?? 1.7,
          z: record.z,
          yaw: record.yaw ?? 0,
          vx: record.vx ?? undefined,
          vz: record.vz ?? undefined,
        });
      }

      // Keep each buffer ordered and trimmed to what playback still needs.
      const horizon = now - SAMPLE_HISTORY_MS;
      for (const track of tracks.values()) {
        track.samples.sort((a, b) => a.t - b.t);
        if (track.samples.length > 2) {
          const keepFrom = track.samples.findIndex((sample) => sample.t >= horizon);
          if (keepFrom > 1) {
            track.samples.splice(0, keepFrom - 1);
          }
        }
      }
    },
    [sessionId, noteGap, noteLateness],
  );

  // Sample the local pose into the outbox, adaptively.
  useEffect(() => {
    if (!isPresenceEnabled()) {
      return;
    }
    const interval = window.setInterval(() => {
      const pose = poseRef.current;
      if (pose == null) {
        return;
      }
      const now = Date.now();
      const last = lastSampledRef.current;

      if (last == null) {
        lastSampledRef.current = { at: now, ...pose, vx: 0, vz: 0 };
        outboxRef.current.push(lastSampledRef.current);
        return;
      }

      const dt = (now - last.at) / 1000;
      if (dt <= 0) {
        return;
      }
      const dx = pose.x - last.x;
      const dz = pose.z - last.z;
      const distance = Math.hypot(dx, dz);
      const turn = Math.abs(angleDelta(last.yaw, pose.yaw));

      // Heading change is what makes a straight line stop being straight, so
      // it earns a sample even when little ground has been covered.
      const heading = distance > 0.02 ? Math.atan2(dx, dz) : null;
      const lastHeading = Math.hypot(last.vx, last.vz) > 0.2 ? Math.atan2(last.vx, last.vz) : null;
      const headingChange =
        heading != null && lastHeading != null ? Math.abs(angleDelta(lastHeading, heading)) : 0;

      const moving = distance > MOVE_EPSILON || turn > TURN_EPSILON;
      // Leaving a standstill is the most valuable sample there is: receivers
      // are dead reckoning from a stale, zero-velocity pose, so the sooner
      // they learn we are moving the smaller their catch-up correction.
      const startedMoving = Math.hypot(last.vx, last.vz) < 0.2 && distance > 0.05;
      const keyframe =
        startedMoving ||
        distance > KEYFRAME_DISTANCE ||
        turn > KEYFRAME_TURN ||
        headingChange > KEYFRAME_HEADING ||
        (moving && now - last.at > KEYFRAME_MAX_GAP_MS);
      if (!keyframe) {
        return;
      }

      const sample: OutboxSample = {
        at: now,
        x: pose.x,
        y: pose.y,
        z: pose.z,
        yaw: pose.yaw,
        pitch: pose.pitch,
        vx: dx / dt,
        vz: dz / dt,
      };
      lastSampledRef.current = sample;
      outboxRef.current.push(sample);
      if (outboxRef.current.length > MAX_SAMPLES_PER_BATCH) {
        outboxRef.current.shift();
      }
    }, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  // Publish the batch of samples taken since the last send.
  useEffect(() => {
    if (!isPresenceEnabled()) {
      return;
    }

    const interval = window.setInterval(() => {
      const now = Date.now();
      if (now < backoffRef.current.until) {
        return;
      }
      const batch = outboxRef.current;
      outboxRef.current = [];

      // Standing still: keep a heartbeat going so we are not evicted.
      if (batch.length === 0) {
        const pose = poseRef.current;
        if (pose == null || now - lastPublishedAtRef.current < HEARTBEAT_MS) {
          return;
        }
        batch.push({ at: now, ...pose, vx: 0, vz: 0 });
      }

      lastPublishedAtRef.current = now;
      const context = contextRef.current;
      // Each sample carries the instant it was actually taken, so the receiver
      // replays the trajectory at its original speed and spacing.
      const records: PresenceRecord[] = batch.map((sample) => ({
        timestamp: sample.at,
        sessionId: context.sessionId,
        userId: context.userId,
        levelKey: context.levelKey,
        state: "alive",
        x: sample.x,
        y: sample.y,
        z: sample.z,
        yaw: sample.yaw,
        pitch: sample.pitch,
        vx: sample.vx,
        vz: sample.vz,
        weapon: context.weapon,
        schemaVersion: PRESENCE_SCHEMA_VERSION,
      }));

      const startedAt = Date.now();
      void publishPresence(records)
        .then(() => {
          sentRef.current += records.length;
          backoffRef.current = { until: 0, delay: 0 };
          // How long a publish actually takes bounds how fresh anyone else's
          // view of us can be, so it is worth watching.
          const elapsed = Date.now() - startedAt;
          publishMsRef.current =
            publishMsRef.current === 0 ? elapsed : publishMsRef.current * 0.8 + elapsed * 0.2;
        })
        .catch((error: unknown) => {
          errorRef.current = `publish: ${describeError(error)}`;
          const delay = Math.min(
            BACKOFF_MAX_MS,
            Math.max(PUBLISH_INTERVAL_MS * 2, backoffRef.current.delay * 2),
          );
          backoffRef.current = { until: Date.now() + delay, delay };
        });
    }, PUBLISH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, []);

  // Reconcile the roster into React state and evict anyone who went quiet.
  // Poses themselves stay in refs, so this never runs per frame.
  useEffect(() => {
    if (!isPresenceEnabled()) {
      return;
    }
    const interval = window.setInterval(() => {
      const cutoff = Date.now() - STALE_AFTER_MS;
      for (const [key, track] of tracksRef.current) {
        if (track.lastSeen < cutoff) {
          tracksRef.current.delete(key);
        }
      }

      setPlayers((previous) => {
        const next: RemotePlayer[] = [];
        for (const track of tracksRef.current.values()) {
          const last = track.samples[track.samples.length - 1];
          next.push({
            sessionId: track.sessionId,
            userId: track.userId,
            levelKey: track.levelKey,
            weapon: track.weapon,
            position: last != null ? [last.x, last.y, last.z] : [0, 1.7, 0],
            yaw: last?.yaw ?? 0,
          });
        }
        const unchanged =
          previous.length === next.length &&
          previous.every((player, index) => {
            const candidate = next[index];
            return (
              player.sessionId === candidate.sessionId &&
              player.levelKey === candidate.levelKey &&
              player.weapon === candidate.weapon &&
              player.userId === candidate.userId
            );
          });
        return unchanged ? previous : next;
      });

      const gapMs = Math.round(arrivalGapRef.current.value);
      const delayMs = Math.round(playbackDelayRef.current);
      // The smallest observed clock offset is the least-delayed update seen,
      // which is the best available estimate of one-way pipeline latency.
      let lagMs = 0;
      for (const track of tracksRef.current.values()) {
        if (track.offset != null && (lagMs === 0 || track.offset < lagMs)) {
          lagMs = Math.max(0, Math.round(track.offset));
        }
      }
      const publishMs = Math.round(publishMsRef.current);
      setStats((previous) =>
        previous.sent === sentRef.current &&
        previous.error === errorRef.current &&
        previous.gapMs === gapMs &&
        previous.delayMs === delayMs &&
        previous.lagMs === lagMs &&
        previous.publishMs === publishMs
          ? previous
          : {
              sent: sentRef.current,
              error: errorRef.current,
              gapMs,
              delayMs,
              lagMs,
              publishMs,
            },
      );
    }, ROSTER_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, []);

  // Read everyone else's poses off the tail of the stream.
  usePolling({
    // Start at the end of the stream: presence has no useful history.
    prepare: async (isCancelled) => {
      try {
        const cursor = await presenceTailCursor();
        if (!isCancelled()) {
          cursorRef.current = cursor;
        }
      } catch (error) {
        // A null cursor simply has the tick try again on the next poll.
        errorRef.current = `read: ${describeError(error)}`;
        setLink("retrying");
      }
    },
    tick: async (isCancelled) => {
      try {
        cursorRef.current = cursorRef.current ?? (await presenceTailCursor());
        const result = await readPresence(cursorRef.current);
        if (isCancelled()) {
          return;
        }
        cursorRef.current = result.cursor;
        applyRecords(result.records, Date.now());
        setLink("live");
      } catch (error) {
        errorRef.current = `read: ${describeError(error)}`;
        setLink("retrying");
      }
    },
    intervalMs: POLL_INTERVAL_MS,
    enabled: isPresenceEnabled(),
  });

  // Say goodbye so our avatar vanishes straight away.
  useEffect(() => {
    if (!isPresenceEnabled()) {
      return;
    }
    const handlePageHide = (): void => {
      const context = contextRef.current;
      void publishPresence([
        {
          timestamp: Date.now(),
          sessionId: context.sessionId,
          userId: context.userId,
          levelKey: context.levelKey,
          state: "left",
          schemaVersion: PRESENCE_SCHEMA_VERSION,
        },
      ]).catch(() => undefined);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);

  return {
    players,
    tracksRef,
    playbackDelayRef,
    reportPose,
    enabled: isPresenceEnabled(),
    link,
    stats,
  };
}
