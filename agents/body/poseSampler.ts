import type { EyePose } from "@/agents/body/Body";

/**
 * Decides when an agent's pose is worth publishing — usePresence's adaptive
 * sampler without React.
 *
 * Densely through turns, sparsely in a straight line, and a heartbeat while
 * standing still so everyone else's roster keeps the agent. The thresholds
 * are usePresence's own, so an agent's avatar interpolates exactly as
 * smoothly as a human's.
 */

const KEYFRAME_DISTANCE = 0.2;
const KEYFRAME_TURN = 0.08;
const KEYFRAME_MAX_GAP_MS = 150;
const HEARTBEAT_MS = 2000;
const MOVE_EPSILON = 0.05;

export class PoseSampler {
  private last: { at: number; pose: EyePose } | null = null;

  /** The pose to publish now, or null when nothing has changed enough. */
  sample(now: number, pose: EyePose): EyePose | null {
    const last = this.last;
    if (last == null) {
      this.last = { at: now, pose };
      return pose;
    }
    const moved = Math.hypot(pose.x - last.pose.x, pose.y - last.pose.y, pose.z - last.pose.z);
    const turned = Math.abs(pose.yaw - last.pose.yaw);
    const gap = now - last.at;
    const moving = moved > MOVE_EPSILON || Math.hypot(pose.vx, pose.vz) > 0.1;

    const due =
      moved >= KEYFRAME_DISTANCE ||
      turned >= KEYFRAME_TURN ||
      (moving && gap >= KEYFRAME_MAX_GAP_MS) ||
      gap >= HEARTBEAT_MS;
    if (!due) {
      return null;
    }
    this.last = { at: now, pose };
    return pose;
  }

  /** Forget the last sample, so the next one is published whatever it is. */
  reset(): void {
    this.last = null;
  }
}
