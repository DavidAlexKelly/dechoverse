import React, { useCallback, useRef } from "react";
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { defaultAppearance } from "@/game/domain/appearance";
import type { Appearance } from "@/game/domain/types";
import { AvatarBody, EYE_RADIUS, EYE_X, EYE_Y, PUPIL_RADIUS } from "@/game/render/AvatarBody";
import css from "@/game/render/labels.module.css";
import type { ActiveMessage } from "@/game/state/useChat";
import type { PlayerTrack, Pose, RemotePlayer, Sample } from "@/game/state/usePresence";
import { EYE_HEIGHT } from "@/game/world/collision";
import { angleDelta } from "@/shared/angles";

/** Samples the camera every frame and hands the pose to the presence hook. */
export function PresencePublisher({ onPose }: { onPose: (pose: Pose) => void }): null {
  const { camera } = useThree();
  const euler = useRef(new THREE.Euler(0, 0, 0, "YXZ"));

  useFrame(() => {
    euler.current.setFromQuaternion(camera.quaternion);
    onPose({
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      yaw: euler.current.y,
      pitch: euler.current.x,
    });
  });

  return null;
}

/**
 * Fallback delay used before any batch arrival has been measured. The live
 * value is adaptive and comes from usePresence via playbackDelayRef.
 */
const PLAYBACK_DELAY_FALLBACK_MS = 320;
/** Corrections bigger than this are teleports (room change): snap, don't slide. */
const SNAP_DISTANCE = 6;
/** How fast the playback clock may run away from real time while catching up. */
const MAX_TIME_DILATION = 0.08;
/** Beyond this drift the playback clock resynchronises instead of easing. */
const CLOCK_RESYNC_MS = 1500;
/** How much further than the straight-line path a tangent may imply. */
const TANGENT_SLACK = 1.6;
/**
 * When the buffer runs dry, keep the avatar moving along its last known
 * velocity for up to this long instead of freezing. Being approximately right
 * now beats being exactly right a second ago.
 */
const MAX_EXTRAPOLATION_MS = 900;
/**
 * Time constant of the glide. For the first fraction of a second the avatar
 * keeps its full speed; beyond that the predicted distance tails off toward
 * GLIDE_TAU_S seconds' worth of travel and no further.
 */
const GLIDE_TAU_S = 0.55;
/**
 * Poses carry the camera position, so subtracting the eye height puts the
 * avatar's feet on whatever ground its owner was standing on — including
 * procedural terrain, with no extra data on the wire.
 */
const AVATAR_EYE_HEIGHT = EYE_HEIGHT;
/** However confident the velocity, never predict further than this. */
const MAX_EXTRAPOLATION_DISTANCE = 5;
/** Walk bob, purely cosmetic: motion reads as intentional rather than sliding. */
const BOB_HEIGHT = 0.05;
const BOB_RATE = 7;

/** Googly eyes: whites are fixed to the face, pupils swing on a spring. */
/**
 * How far a pupil may slide from centre before it would leave the white.
 *
 * The eye geometry itself lives with the body it is part of, in AvatarBody.
 */
const PUPIL_MAX_OFFSET = EYE_RADIUS - PUPIL_RADIUS - 0.008;
/** Spring pulling the pupil back to centre, and the damping on that spring. */
const PUPIL_STIFFNESS = 110;
const PUPIL_DAMPING = 7;
/** How strongly acceleration throws the pupils around. */
const PUPIL_ACCEL_SCALE = 0.9;

/** Uniform Catmull-Rom, so the path curves through samples instead of zig-zagging. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Cubic Hermite with the publisher's own velocities as tangents. Exact, where
 * Catmull-Rom only estimates the tangent from neighbouring samples — so a
 * sharp stop or a hard turn is reproduced instead of being rounded off.
 *
 * `span` is in seconds, matching the m/s velocities.
 */
function hermite(p1: number, v1: number, p2: number, v2: number, span: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p1 + h10 * span * v1 + h01 * p2 + h11 * span * v2;
}

/**
 * Picks the pose to render at `renderTime` from a trajectory buffer.
 *
 * Position uses the publisher's velocities as exact tangents when available,
 * falling back to a Catmull-Rom spline through the surrounding samples. Yaw
 * stays linear on the shortest arc, because splining an angle overshoots in a
 * way that reads as a head-shake.
 */
function poseAt(samples: Sample[], renderTime: number): Sample | null {
  if (samples.length === 0) {
    return null;
  }
  if (samples.length === 1 || renderTime <= samples[0].t) {
    return samples[0];
  }
  const last = samples[samples.length - 1];
  if (renderTime >= last.t) {
    // Past the newest sample: dead reckon along the last known velocity rather
    // than freezing. The prediction tapers off as it ages, so a stale velocity
    // eases to a halt instead of sprinting into a wall, and the correction
    // when the next update lands is absorbed by the render smoothing.
    const ahead = Math.min(renderTime - last.t, MAX_EXTRAPOLATION_MS);
    if (last.vx == null || last.vz == null || ahead <= 0) {
      return last;
    }

    // Momentum: hold the last known speed rather than easing off immediately,
    // so a player who is really still walking keeps walking here. The distance
    // travelled approaches a limit asymptotically, so a stale velocity glides
    // to a stop instead of either stuttering or running away.
    const seconds = GLIDE_TAU_S * (1 - Math.exp(-ahead / 1000 / GLIDE_TAU_S));
    let dx = last.vx * seconds;
    let dz = last.vz * seconds;
    const predicted = Math.hypot(dx, dz);
    if (predicted > MAX_EXTRAPOLATION_DISTANCE) {
      const scale = MAX_EXTRAPOLATION_DISTANCE / predicted;
      dx *= scale;
      dz *= scale;
    }
    return {
      t: renderTime,
      x: last.x + dx,
      y: last.y,
      z: last.z + dz,
      yaw: last.yaw,
    };
  }

  for (let index = samples.length - 1; index > 0; index--) {
    const after = samples[index];
    const before = samples[index - 1];
    if (renderTime < before.t || renderTime > after.t) {
      continue;
    }

    const span = after.t - before.t;
    const alpha = span <= 0 ? 1 : (renderTime - before.t) / span;
    const y = before.y + (after.y - before.y) * alpha;
    const yaw = before.yaw + angleDelta(before.yaw, after.yaw) * alpha;

    // Prefer the publisher's own tangents when it sent them.
    if (before.vx != null && before.vz != null && after.vx != null && after.vz != null) {
      const seconds = span / 1000;

      // Over a long span a tangent can carry the curve well past the straight
      // line between the samples and swing back — a loop, not a walk. Clamp
      // each tangent so it cannot imply much more travel than actually
      // happened. Matters most when updates are sparse.
      const distance = Math.hypot(after.x - before.x, after.z - before.z);
      const maxSpeed = seconds > 0 ? (distance * TANGENT_SLACK) / seconds : 0;
      const scaleFor = (vx: number, vz: number): number => {
        const speed = Math.hypot(vx, vz);
        return speed > maxSpeed && speed > 0 ? maxSpeed / speed : 1;
      };
      const beforeScale = scaleFor(before.vx, before.vz);
      const afterScale = scaleFor(after.vx, after.vz);

      return {
        t: renderTime,
        x: hermite(
          before.x,
          before.vx * beforeScale,
          after.x,
          after.vx * afterScale,
          seconds,
          alpha,
        ),
        y,
        z: hermite(
          before.z,
          before.vz * beforeScale,
          after.z,
          after.vz * afterScale,
          seconds,
          alpha,
        ),
        yaw,
      };
    }

    const previous = samples[index - 2] ?? before;
    const following = samples[index + 1] ?? after;
    return {
      t: renderTime,
      x: catmullRom(previous.x, before.x, after.x, following.x, alpha),
      y,
      z: catmullRom(previous.z, before.z, after.z, following.z, alpha),
      yaw,
    };
  }

  return last;
}

/**
 * Other players in this room, replayed from their trajectory buffers a little
 * behind real time so motion is continuous instead of stepped.
 */
export function Avatars({
  players,
  tracksRef,
  playbackDelayRef,
  speech,
  appearances,
}: {
  players: RemotePlayer[];
  tracksRef: React.MutableRefObject<Map<string, PlayerTrack>>;
  playbackDelayRef?: React.MutableRefObject<number>;
  /**
   * Messages currently being spoken, keyed by sessionId. Kept separate from
   * `players` on purpose: that roster only reconciles every few hundred
   * milliseconds and short-circuits when nothing it compares has changed, so
   * driving bubbles through it would make them both late and unreliable.
   */
  speech?: Map<string, ActiveMessage>;
  /**
   * Chosen appearances, keyed by userId. Anyone missing from it has never
   * opened the character screen and gets the colour their name hashes to.
   */
  appearances?: Map<string, Appearance>;
}): React.ReactElement {
  const groups = useRef(new Map<string, THREE.Group>());
  /** Last rendered transform per player, so a re-attach does not rewind. */
  const lastPose = useRef(new Map<string, { x: number; y: number; z: number; yaw: number }>());
  /** Per-player animation state: walk bob, and the googly pupil springs. */
  const motion = useRef(
    new Map<
      string,
      {
        speed: number;
        phase: number;
        /** Local-space velocity last frame, for deriving acceleration. */
        lastRight: number;
        lastForward: number;
        /** Pupil offset and its velocity, in eye-local metres. */
        px: number;
        py: number;
        pvx: number;
        pvy: number;
      }
    >(),
  );
  /**
   * Ref callbacks are cached per player. An inline callback would be a new
   * function on every render, which makes React detach and re-attach the ref
   * and would snap the avatar back to wherever it was first placed.
   */
  const refCallbacks = useRef(new Map<string, (group: THREE.Group | null) => void>());
  /**
   * Playback clock, in the local timeline. Rather than reading Date.now() each
   * frame, it advances at a slightly adjusted rate to converge on the target
   * delay. That way an adaptive buffer resize eases in over a second instead
   * of stepping the whole world back a hundred milliseconds.
   */
  const clock = useRef<number | null>(null);

  const register = useCallback(
    (sessionId: string) => {
      const existing = refCallbacks.current.get(sessionId);
      if (existing != null) {
        return existing;
      }
      const callback = (group: THREE.Group | null): void => {
        if (group == null) {
          groups.current.delete(sessionId);
          return;
        }
        groups.current.set(sessionId, group);

        // Place a newly mounted avatar at its remembered transform, or at the
        // current playback pose if this is the first time we have seen them.
        const remembered = lastPose.current.get(sessionId);
        if (remembered != null) {
          group.position.set(remembered.x, remembered.y, remembered.z);
          group.rotation.y = remembered.yaw;
          return;
        }
        const track = tracksRef.current.get(sessionId);
        const delay = playbackDelayRef?.current ?? PLAYBACK_DELAY_FALLBACK_MS;
        const pose = track != null ? poseAt(track.samples, Date.now() - delay) : null;
        if (pose != null) {
          group.position.set(pose.x, pose.y - AVATAR_EYE_HEIGHT, pose.z);
          group.rotation.y = pose.yaw;
          lastPose.current.set(sessionId, {
            x: pose.x,
            y: pose.y - AVATAR_EYE_HEIGHT,
            z: pose.z,
            yaw: pose.yaw,
          });
        }
      };
      refCallbacks.current.set(sessionId, callback);
      return callback;
    },
    [tracksRef, playbackDelayRef],
  );

  useFrame((_, delta) => {
    const playbackDelay = playbackDelayRef?.current ?? PLAYBACK_DELAY_FALLBACK_MS;

    // Advance the playback clock, dilating time slightly to absorb drift.
    const desired = Date.now() - playbackDelay;
    let renderTime = clock.current;
    if (renderTime == null || Math.abs(desired - renderTime) > CLOCK_RESYNC_MS) {
      renderTime = desired;
    } else {
      const drift = desired - renderTime;
      const rate = 1 + THREE.MathUtils.clamp(drift / 1000, -MAX_TIME_DILATION, MAX_TIME_DILATION);
      renderTime += delta * 1000 * rate;
    }
    clock.current = renderTime;

    for (const player of players) {
      const group = groups.current.get(player.sessionId);
      const track = tracksRef.current.get(player.sessionId);
      if (group == null || track == null) {
        continue;
      }
      const pose = poseAt(track.samples, renderTime);
      if (pose == null) {
        continue;
      }

      const dx = pose.x - group.position.x;
      const dz = pose.z - group.position.z;
      // Big corrections (someone set off while we were predicting a standstill)
      // are eased in over a longer window so they read as accelerating rather
      // than teleporting; small ones stay snappy.
      const error = Math.hypot(dx, dz);
      const timeConstant = error > 1 ? 0.22 : 0.07;
      const smoothing = 1 - Math.exp(-delta / timeConstant);

      if (dx * dx + dz * dz > SNAP_DISTANCE * SNAP_DISTANCE) {
        // A teleport (level change, or a very late batch): jump, do not slide
        // the avatar across the whole arena.
        group.position.set(pose.x, pose.y - AVATAR_EYE_HEIGHT, pose.z);
        group.rotation.y = pose.yaw;
      } else {
        group.position.x += dx * smoothing;
        group.position.z += dz * smoothing;
        group.position.y += (pose.y - AVATAR_EYE_HEIGHT - group.position.y) * smoothing;
        group.rotation.y += angleDelta(group.rotation.y, pose.yaw) * smoothing;
      }

      // Walk bob, scaled by how fast they are actually travelling.
      const previous = lastPose.current.get(player.sessionId);
      const travelled =
        previous == null
          ? 0
          : Math.hypot(group.position.x - previous.x, group.position.z - previous.z);
      const state = motion.current.get(player.sessionId) ?? {
        speed: 0,
        phase: 0,
        lastRight: 0,
        lastForward: 0,
        px: 0,
        py: 0,
        pvx: 0,
        pvy: 0,
      };
      const instantaneous = delta > 0 ? travelled / delta : 0;
      state.speed += (instantaneous - state.speed) * Math.min(1, delta * 6);
      state.phase += delta * BOB_RATE * Math.min(1, state.speed / 4);

      // Googly physics: the pupils are loose discs, so what moves them is the
      // avatar's acceleration, resolved into the face's own axes.
      const step = Math.max(delta, 1 / 240);
      const worldVx = previous == null ? 0 : (group.position.x - previous.x) / step;
      const worldVz = previous == null ? 0 : (group.position.z - previous.z) / step;
      const cos = Math.cos(group.rotation.y);
      const sin = Math.sin(group.rotation.y);
      const right = worldVx * cos - worldVz * sin;
      const forward = -(worldVx * sin + worldVz * cos);
      const accelRight = (right - state.lastRight) / step;
      const accelForward = (forward - state.lastForward) / step;
      state.lastRight = right;
      state.lastForward = forward;

      // Spring the pupils back to centre while acceleration throws them about;
      // the bob adds a little vertical shake so they never look glued.
      const bobShake = Math.cos(state.phase) * state.speed * 0.6;
      const forceX = -accelRight * PUPIL_ACCEL_SCALE;
      const forceY = -accelForward * PUPIL_ACCEL_SCALE * 0.35 - bobShake;
      state.pvx += (forceX - PUPIL_STIFFNESS * state.px - PUPIL_DAMPING * state.pvx) * step;
      state.pvy += (forceY - PUPIL_STIFFNESS * state.py - PUPIL_DAMPING * state.pvy) * step;
      state.px += state.pvx * step;
      state.py += state.pvy * step;
      const swing = Math.hypot(state.px, state.py);
      if (swing > PUPIL_MAX_OFFSET) {
        const scale = PUPIL_MAX_OFFSET / swing;
        state.px *= scale;
        state.py *= scale;
        state.pvx *= scale;
        state.pvy *= scale;
      }

      for (const side of ["pupilLeft", "pupilRight"] as const) {
        const pupil = group.getObjectByName(side);
        if (pupil != null) {
          const base = side === "pupilLeft" ? -EYE_X : EYE_X;
          pupil.position.x = base + state.px;
          pupil.position.y = EYE_Y + state.py;
        }
      }

      motion.current.set(player.sessionId, state);
      // Bob the body only: the shadow puddle stays welded to the floor.
      const body = group.getObjectByName("body");
      if (body != null) {
        body.position.y = Math.sin(state.phase) * BOB_HEIGHT * Math.min(1, state.speed / 2.5);
      }

      lastPose.current.set(player.sessionId, {
        x: group.position.x,
        y: group.position.y,
        z: group.position.z,
        yaw: group.rotation.y,
      });
    }

    // Forget players who have left, so a returning session starts fresh.
    if (lastPose.current.size > players.length) {
      const present = new Set(players.map((player) => player.sessionId));
      for (const sessionId of lastPose.current.keys()) {
        if (!present.has(sessionId)) {
          lastPose.current.delete(sessionId);
          refCallbacks.current.delete(sessionId);
          motion.current.delete(sessionId);
        }
      }
    }
  });

  return (
    <group>
      {players.map((player) => {
        const appearance = appearances?.get(player.userId) ?? defaultAppearance(player.userId);
        const message = speech?.get(player.sessionId) ?? null;
        return (
          <group key={player.sessionId} ref={register(player.sessionId)}>
            <AvatarBody appearance={appearance} />

            <Html position={[0, 2.3, 0]} center distanceFactor={16}>
              <div className={css.avatarLabel} style={{ borderColor: appearance.color }}>
                {player.userId}
              </div>
            </Html>

            {/* What they are saying, above the name plate. Visible at any
                distance in the room; only the audio is proximity gated. */}
            {message != null && (
              <Html position={[0, 3.1, 0]} center distanceFactor={16}>
                {/* Deliberately not tinted per player: the bubble is plain
                    white with a black outline, and the name plate below
                    already carries their colour. */}
                <div className={css.speechBubble}>{message.text}</div>
              </Html>
            )}
          </group>
        );
      })}
    </group>
  );
}
