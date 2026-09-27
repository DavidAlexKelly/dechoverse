import type { AppLink } from "@/foundry/apps";

/** What happens when the block is shot. */
export type TargetKind = "enter" | "resource" | "app";

/** A shootable block in the level. */
export interface TargetSpec {
  /** Stable id, used to resolve what was hit. */
  id: string;
  /** Foundry rid or app id backing this block. */
  rid: string;
  kind: TargetKind;
  label: string;
  /** Short caption under the label, e.g. the resource type. */
  caption?: string;
  color: string;
  /** Block height in metres: containers you can enter are taller. */
  height: number;
  /** External link opened when an "app" block is shot. */
  url?: string;
  position: [number, number, number];
}

/** Half-width of the walled arena. */
export const ARENA_HALF_SIZE = 45;
/** Personal rooms are a fraction of the size: somewhere to make your own. */
export const MYSPACE_HALF_SIZE = 12;
const MYSPACE_PREFIX = "myspace:";

/** Room key for a player's personal room, derived from their name. */
export function myspaceLevelKey(userId: string): string {
  return `${MYSPACE_PREFIX}${userId}`;
}

/**
 * The owner encoded in a personal room key, or null when the key is not a
 * personal room at all.
 *
 * Ownership is read back out of the key rather than tracked separately, so it
 * cannot drift from the room it describes.
 */
export function myspaceOwner(levelKey: string): string | null {
  return levelKey.startsWith(MYSPACE_PREFIX) ? levelKey.slice(MYSPACE_PREFIX.length) : null;
}

const SPACE_COLOR = "#a100ff";
const FOLDER_COLOR = "#7a5cff";

/** Colour per Compass resource family, so a level is readable at a glance. */
const TYPE_COLORS: Array<[RegExp, string]> = [
  [/^FOUNDRY_DATASET$|^TABLES_TABLE$|^GPS_VIEW$/, "#00d2ff"],
  [/^EDDIE_|^DREDDIE_/, "#00ffb2"],
  [/^STEMMA_REPOSITORY$|^FOUNDRY_CONTAINER_SERVICE_CONTAINER$/, "#ffd166"],
  [/^WORKSHOP_|^SLATE_|^FOUNDRY_DEPLOYED_APP$|^THIRD_PARTY_APPLICATIONS_/, "#ff8f4d"],
  [/^AIP_|^LOGIC_FLOWS_|^MODELS_/, "#ff5c8a"],
  [/^NOTEPAD_|^REPORT_|^BLOBSTER_|^FUSION_DOCUMENT$/, "#c4c9d4"],
  [/^MAGRITTE_/, "#5ce1e6"],
  [/^OBJECT_SENTINEL_|^TAURUS_|^FLOW_/, "#b0ff6b"],
];

export function colorForType(type: string): string {
  for (const [pattern, color] of TYPE_COLORS) {
    if (pattern.test(type)) {
      return color;
    }
  }
  return "#8892a6";
}

interface ScatterItem {
  rid: string;
  name: string;
  caption?: string;
  color?: string;
  enterable: boolean;
}

/**
 * Scatters blocks around the player spawn point (the origin) using a golden
 * angle spiral so they never overlap and stay inside the arena.
 */
export function scatterTargets(items: ScatterItem[], levelKey: string): TargetSpec[] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  return items.map((item, index) => {
    const radius = Math.min(9 + Math.sqrt(index) * 5.5, ARENA_HALF_SIZE - 6);
    const angle = index * goldenAngle;
    return {
      id: `${levelKey}-${item.rid}`,
      rid: item.rid,
      kind: item.enterable ? "enter" : "resource",
      label: item.name,
      caption: item.caption,
      color: item.color ?? (item.enterable ? FOLDER_COLOR : SPACE_COLOR),
      height: item.enterable ? 4.2 : 2.8,
      position: [Math.cos(angle) * radius, 0, Math.sin(angle) * radius] as [number, number, number],
    };
  });
}

/** Rid used by the portal block that leads to the list of Spaces. */
export const SPACES_PORTAL_RID = "__spaces__";
/** Rid used by the portal block that leads to DechoWorld. */
export const WORLD_PORTAL_RID = "__world__";
/** Rid used by the portal block that leads to DechoWorld 2. */
export const WORLD2_PORTAL_RID = "__world2__";
/**
 * Room key for DechoWorld.
 *
 * Deliberately still "world:plains": every mark — paint, props, doors and dug
 * holes — is scoped by this string, so renaming it would orphan everything
 * already built there. The display name is separate.
 */
export const WORLD_LEVEL_KEY = "world:plains";

/**
 * Room key for DechoWorld 2, whose ground is a real DEM rather than noise.
 *
 * A key of its own, and not a variant of the first: everything anyone paints,
 * places or digs is scoped by this string, so the two worlds keep their marks
 * apart even though they share every line of the terrain code.
 */
export const WORLD2_LEVEL_KEY = "world:earth";

/**
 * The hub room: a tall "Spaces" portal straight ahead of the spawn point and
 * one block per Foundry application, laid out in an arc around it.
 */
export function buildHubTargets(apps: AppLink[]): TargetSpec[] {
  const portal: TargetSpec = {
    id: `hub-${SPACES_PORTAL_RID}`,
    rid: SPACES_PORTAL_RID,
    kind: "enter",
    label: "Spaces",
    caption: "Enter the filesystem",
    color: SPACE_COLOR,
    height: 5.4,
    position: [-13, 0, -6],
  };

  const dechoWorld: TargetSpec = {
    id: `hub-${WORLD_PORTAL_RID}`,
    rid: WORLD_PORTAL_RID,
    kind: "enter",
    label: "DechoWorld",
    caption: "Endless procedural world",
    color: "#5fbf5f",
    height: 5.4,
    position: [13, 0, -6],
  };

  /**
   * Beside DechoWorld rather than opposite it, so the two read as a pair of
   * doors onto the same idea: one invented landscape, one real one. Clear of
   * the application arc, which reaches x = ±14.7 at z = -8.5.
   */
  const dechoWorld2: TargetSpec = {
    id: `hub-${WORLD2_PORTAL_RID}`,
    rid: WORLD2_PORTAL_RID,
    kind: "enter",
    label: "DechoWorld 2",
    caption: "Real terrain, life size",
    color: "#4d9de0",
    height: 5.4,
    position: [22, 0, 0],
  };

  const arc = apps.map((app, index) => {
    // Spread the apps evenly across a 120° arc in front of the player.
    const span = Math.PI / 3;
    const step = apps.length === 1 ? 0 : (span * 2) / (apps.length - 1);
    const angle = -span + step * index;
    const radius = 17;
    return {
      id: `hub-${app.id}`,
      rid: app.id,
      kind: "app" as const,
      label: app.name,
      caption: app.caption,
      color: app.color,
      height: 3.6,
      url: app.url,
      position: [Math.sin(angle) * radius, 0, -Math.cos(angle) * radius] as [
        number,
        number,
        number,
      ],
    };
  });

  return [portal, dechoWorld, dechoWorld2, ...arc];
}

export { SPACE_COLOR, FOLDER_COLOR };
