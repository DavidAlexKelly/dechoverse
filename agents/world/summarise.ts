import type { Mode } from "@/agents/brain/stateMachine";
import { mentionsName, plainName } from "@/agents/config/identity";
import type { HeardMessage, WorldPlayer } from "@/agents/world/WorldView";
import type { Cube } from "@/game/domain/types";

/**
 * The compact state Jev decides over.
 *
 * Jev is billed on input tokens and answers faster the less it has to read,
 * so this is a summary, not a dump: the nearest few people, the last few
 * lines of chat, and counts rather than coordinates. Relative terms — "front
 * left", "approaching" — are what a reflex needs; absolute positions are not.
 */

export interface SelfSummary {
  name: string;
  mode: Mode;
  modeAgeS: number;
  goal: string | null;
  building: { title: string; placed: number; total: number } | null;
  stalledS: number;
  x: number;
  z: number;
  yaw: number;
}

export interface PendingSummary {
  key: string;
  message: HeardMessage;
  distance: number | null;
}

export interface SummaryInput {
  self: SelfSummary;
  now: number;
  players: WorldPlayer[];
  recentChat: HeardMessage[];
  pending: PendingSummary | null;
  partner: string | null;
  partnerLastHeardS: number | null;
  cubes: Cube[];
  ownUserId: string;
}

const MAX_PEOPLE = 6;
const MAX_CHAT = 4;
const NEARBY_RADIUS = 20;

function bearing(self: SelfSummary, x: number, z: number): string {
  // Angle of the other person relative to where this agent is facing.
  const toward = Math.atan2(-(x - self.x), -(z - self.z));
  let relative = toward - self.yaw;
  while (relative > Math.PI) relative -= Math.PI * 2;
  while (relative < -Math.PI) relative += Math.PI * 2;
  const degrees = (relative * 180) / Math.PI;
  if (Math.abs(degrees) < 30) return "in front";
  if (Math.abs(degrees) > 150) return "behind";
  const side = degrees > 0 ? "left" : "right";
  return Math.abs(degrees) < 90 ? `front-${side}` : `behind-${side}`;
}

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function summarise(input: SummaryInput): Record<string, unknown> {
  const { self, now } = input;

  const people = input.players
    .map((player) => ({ player, distance: Math.hypot(player.x - self.x, player.z - self.z) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_PEOPLE)
    .map(({ player, distance }) => {
      // Closing on this agent: velocity points roughly at it.
      const towardX = self.x - player.x;
      const towardZ = self.z - player.z;
      const closing = (player.vx * towardX + player.vz * towardZ) / Math.max(distance, 0.1);
      const said = input.recentChat.filter((message) => message.sessionId === player.sessionId);
      const lastSaid = said.length > 0 ? said[said.length - 1] : undefined;
      return {
        name: plainName(player.userId),
        kind: player.isAgent ? "ai" : "human",
        distanceM: round(distance),
        bearing: bearing(self, player.x, player.z),
        approaching: closing > 0.5,
        lastSpokeS: lastSaid != null ? round((now - lastSaid.receivedAt) / 1000, 0) : null,
      };
    });

  const chat = input.recentChat.slice(-MAX_CHAT).map((message) => ({
    from: message.userId === input.ownUserId ? "me" : plainName(message.userId),
    text: message.text,
    ageS: round((now - message.receivedAt) / 1000, 0),
  }));

  let nearbyCubes = 0;
  const colours = new Map<string, number>();
  for (const cube of input.cubes) {
    if (Math.hypot(cube.x - self.x, cube.z - self.z) > NEARBY_RADIUS) {
      continue;
    }
    nearbyCubes++;
    colours.set(cube.color, (colours.get(cube.color) ?? 0) + 1);
  }

  return {
    self: {
      name: self.name,
      behaviour: self.mode,
      behaviourForS: round(self.modeAgeS, 0),
      goal: self.goal,
      building: self.building,
      stalledS: round(self.stalledS, 1),
    },
    pendingMessage:
      input.pending == null
        ? null
        : {
            from: plainName(input.pending.message.userId),
            fromKind: input.pending.message.isAgent ? "ai" : "human",
            text: input.pending.message.text,
            ageS: round((now - input.pending.message.receivedAt) / 1000, 0),
            distanceM: input.pending.distance == null ? null : round(input.pending.distance),
            mentionsMyName: mentionsName(input.pending.message.text, self.name),
          },
    conversation:
      input.partner == null
        ? null
        : { with: plainName(input.partner), lastHeardS: input.partnerLastHeardS },
    people,
    recentChat: chat,
    surroundings: {
      cubesWithin20m: nearbyCubes,
      commonColours: [...colours.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([colour]) => colour),
    },
  };
}

/** Colours of cubes near a point, most common first. */
export function nearbyColours(cubes: Cube[], x: number, z: number, radius = 25): string[] {
  const counts = new Map<string, number>();
  for (const cube of cubes) {
    if (Math.hypot(cube.x - x, cube.z - z) <= radius) {
      counts.set(cube.color, (counts.get(cube.color) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([colour]) => colour);
}
