import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Canvas } from "@react-three/fiber";
import { useQuery } from "@tanstack/react-query";
import * as THREE from "three";
import { APP_LINKS, type AppLink } from "@/foundry/apps";
import { foundryUrl } from "@/foundry/client";
import { describeError } from "@/foundry/errors";
import { type FsNode, humanizeType, listChildren, listSpaces } from "@/foundry/filesystem";
import { anonymousName, cachedDisplayName, fetchDisplayName } from "@/foundry/identity";
import { listObjectModels, modelLoadVersion, subscribeModelLoads } from "@/foundry/models";
import {
  findMediaItemByPath,
  getTagImageName,
  isPng,
  loadTagTexture,
  readLocalImage,
  uploadTagImage,
} from "@/foundry/tagMedia";
import { MAX_STROKE_DABS, MAX_SWEEP_PADS } from "@/game/domain/codec";
import {
  type Appearance,
  DOOR_TARGET_PREFIX,
  type Dab,
  type FlatPad,
  type Impact,
  type PaintStroke,
} from "@/game/domain/types";
import { Arena } from "@/game/render/Arena";
import { Avatars, PresencePublisher } from "@/game/render/Avatars";
import { BuildingLayer } from "@/game/render/BuildingLayer";
import { CubeLayer } from "@/game/render/CubeLayer";
import { DoorLayer } from "@/game/render/DoorLayer";
import { FurnitureLayer } from "@/game/render/FurnitureLayer";
import { Impacts } from "@/game/render/Impacts";
import { PaintLayer } from "@/game/render/PaintLayer";
import { PatchLayer } from "@/game/render/PatchLayer";
import Player, { type ControlMode, type ShotResult, type WeaponId } from "@/game/render/Player";
import { RoadLayer } from "@/game/render/RoadLayer";
import { StrokeLayer } from "@/game/render/StrokeLayer";
import { TagLayer } from "@/game/render/TagLayer";
import { TargetBlock } from "@/game/render/TargetBlock";
import { WaterLayer } from "@/game/render/WaterLayer";
import { DaylightSky, DechoWorld } from "@/game/render/World";
import { isMuted, primeSpeech, setMuted as setSpeechMuted } from "@/game/state/speech";
import { useCharacter } from "@/game/state/useCharacter";
import { useChat } from "@/game/state/useChat";
import { useMarkSync } from "@/game/state/useMarkSync";
import { type Pose, usePresence } from "@/game/state/usePresence";
import CharacterPanel from "@/game/ui/CharacterPanel";
import ChatComposer from "@/game/ui/ChatComposer";
import css from "@/game/ui/Hud.module.css";
import VirtualCursor from "@/game/ui/VirtualCursor";
import ColorWheel from "@/game/ui/pickers/ColorWheel";
import CreatePicker, { type CreateMode } from "@/game/ui/pickers/CreatePicker";
import DrawPicker, { type DrawMode } from "@/game/ui/pickers/DrawPicker";
import TagPicker from "@/game/ui/pickers/TagPicker";
import { modelPathOf, needsTerrain, obstacleFor } from "@/game/world/furnitureCatalog";
import { type GeoTerrain, loadGeoTerrain } from "@/game/world/geoterrain";
import {
  ARENA_HALF_SIZE,
  MYSPACE_HALF_SIZE,
  SPACES_PORTAL_RID,
  type TargetSpec,
  WORLD2_LEVEL_KEY,
  WORLD2_PORTAL_RID,
  WORLD_LEVEL_KEY,
  WORLD_PORTAL_RID,
  buildHubTargets,
  colorForType,
  myspaceLevelKey,
  myspaceOwner,
  scatterTargets,
} from "@/game/world/level";
import { loadSurface } from "@/game/world/surface";
import { PROCEDURAL_TERRAIN, type TerrainStyle } from "@/game/world/terrainStyle";
import {
  DEFAULT_CUBE_COLOR,
  DEFAULT_CUBE_OPACITY,
  MIN_CUBE_OPACITY,
  buildVoxelMap,
  sameCell,
  snapToCell,
} from "@/game/world/voxels";
import { buildTerrainSampler } from "@/game/world/worldgen";

/**
 * A slot on the bar. Deliberately not the same thing as a WeaponId: Draw
 * covers both paint and tags, and Create covers doors as well as props, so
 * the weapon the Player acts on is derived from the tool plus its mode.
 */
type ToolId = "select" | "draw" | "create" | "eraser";

interface ToolEntry {
  id: ToolId;
  name: string;
  hint: string;
}

/** Tools available in every room, in slot order. */
const BASE_TOOLS: ToolEntry[] = [
  { id: "select", name: "Select", hint: "Click a block to open it" },
  {
    id: "draw",
    name: "Draw",
    hint: "F switches paint and tags · C picks a colour",
  },
];

/**
 * Offered only where building is allowed: a personal room, or DechoWorld.
 *
 * The hub and the filesystem rooms are a view of Foundry rather than somewhere
 * to build — their blocks stand for real spaces, projects and resources, and a
 * stack of cubes in front of one is in the way of reading the place. Paint,
 * tags and the eraser stay available everywhere, since marking a wall is not
 * the same as putting one up.
 */
const CREATE_TOOL: ToolEntry = {
  id: "create",
  name: "Create",
  hint: "F chooses what to make",
};

/** Always last, whatever else is available. */
const ERASER_TOOL: ToolEntry = {
  id: "eraser",
  name: "Eraser",
  hint: "Hold to wipe paint and tags · keep aim on cubes and props",
};

/** Radius of one flatten pad, and how far the aim moves before laying another. */
const FLATTEN_RADIUS = 3;
const FLATTEN_STEP = 1.2;

/**
 * Expands the sweep in progress into pads, so the terrain can be sampled
 * against it and the levelling is visible while you are still doing it.
 */
function padsFromSweep(sweep: { level: number; pads: Array<[number, number]> }): FlatPad[] {
  return sweep.pads.map(([x, z], index) => ({
    id: `wet#${index}`,
    markId: "wet",
    x,
    z,
    radius: FLATTEN_RADIUS,
    level: sweep.level,
  }));
}
/** Radius and depth of one dig. Repeated digs deepen and merge. */
const DIG_RADIUS = 2.2;
const DIG_DEPTH = 0.9;

/** Milliseconds between placing doors. One per person, so this is generous. */
const DOOR_COOLDOWN_MS = 60000;

/** Milliseconds between two placed props. */
const OBJECT_COOLDOWN_MS = 8000;
/** Props only stand on roughly level ground. */
const FLOOR_NORMAL_MIN_Y = 0.7;

const SPRAY_COLORS = ["#a100ff", "#00d2ff", "#00ffb2", "#ffd166", "#ff5c8a", "#ffffff"];

/** Cosmetic wobble for the spray cone, kept deterministic (no Math.random). */
function sprayJitter(seed: number): { spread: number; angle: number; size: number } {
  return {
    spread: 0.06 + ((seed * 37) % 23) / 130,
    angle: ((seed * 61) % 360) * (Math.PI / 180),
    size: 0.16 + ((seed * 17) % 13) / 90,
  };
}

/**
 * Whether the HUD carries the readouts that only mean something to whoever is
 * working on the game: the mark count, the presence link state, poses sent,
 * the latency figures, and the raw text of a stream error.
 *
 * True under `npm run dev` and `npm run dev:remote`, false in a built app,
 * and a compile-time constant either way — so in production the strings are
 * not merely hidden, they are not in the bundle.
 *
 * What survives in production is what a player needs rather than what a
 * developer wants: the sync dot and its state, whether anyone else is in the
 * room, and whether chat audio is muted. "Offline · paint is local only" still
 * says that work is not being saved; it just no longer says why.
 */
const SHOW_DIAGNOSTICS = import.meta.env.DEV;

/**
 * Longest sub-mode label a tool slot will show before it is cut short.
 *
 * The create tool's mode can be a model name, which is a file name — and
 * "Cutting board 02" is wider than the slot it sits in.
 */
const MAX_MODE_LABEL = 16;

/**
 * A hex colour with an alpha byte appended, for a swatch that has to show how
 * see-through the thing it stands for is.
 *
 * The alpha goes in the colour rather than on the element so the swatch's
 * border stays crisp — fading the whole element would fade its outline too,
 * and a faint block would leave an almost invisible dot on the bar.
 */
function withAlpha(color: string, opacity: number): string {
  if (opacity >= 1) {
    return color;
  }
  const byte = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  return `${color}${byte.toString(16).padStart(2, "0")}`;
}

/** How much wheel movement, in pixels, counts as one step along the bar. */
const WHEEL_STEP = 10;
/** Shortest gap between two steps, however hard the wheel is spun. */
const WHEEL_COOLDOWN_MS = 50;
/** A gap longer than this starts the accumulation again. */
const WHEEL_IDLE_MS = 220;

/**
 * How many blocks a room can hold before their labels are drawn only near the
 * player.
 *
 * Each label is a DOM element that drei re-positions every frame, so a folder
 * with a couple of hundred children was spending most of a frame laying out
 * text. Small rooms — the hub, a modest folder — keep every label, because
 * that is where reading the place at a glance matters and the cost is nil.
 */
const LABEL_BUDGET = 40;
/**
 * How near, in metres, a block has to be to be labelled in a crowded room.
 *
 * Blocks scatter out to about 39 m, so this is roughly the near half of the
 * arena — and drei scales labels with distance, so the ones dropped were only
 * a few pixels tall anyway.
 */
const NEAR_LABEL_RADIUS = 24;

/** Radius the eraser clears around the aim point. */
const MOP_RADIUS = 1;
/** How long the aim must stay on a cube or prop before it is removed. */
const ERASE_HOLD_MS = 200;
/** Longest gap between erase ticks credited to the hold, matching the tool's rate. */
const ERASE_TICK_MS = 60;
/** A longer gap than this means the trigger was released; the hold restarts. */
const ERASE_RESET_MS = 160;
/** Every tag is scaled to fit inside this square, keeping its aspect ratio. */
const TAG_FIT = 3;
/** Milliseconds between two tags. */
const TAG_COOLDOWN_MS = 5000;

/** One step of the drill-down: spaces → space → project → folder → ... */
interface Crumb {
  rid: string;
  name: string;
  kind: "spaces" | "space" | "project" | "folder" | "myspace" | "world";
}

/** What the info panel is currently showing. */
type Detail = { type: "resource"; node: FsNode } | { type: "app"; app: AppLink };

const LEVEL_KIND_LABEL: Record<Crumb["kind"], string> = {
  spaces: "FILESYSTEM",
  space: "SPACE",
  project: "PROJECT",
  folder: "FOLDER",
  myspace: "PERSONAL ROOM",
  world: "DECHOWORLD",
};

function Game(): React.ReactElement {
  const [stack, setStack] = useState<Crumb[]>([]);
  const [impacts, setImpacts] = useState<Impact[]>([]);
  const [hitTargetId, setHitTargetId] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tool, setTool] = useState<ToolId>("select");
  const [drawMode, setDrawMode] = useState<DrawMode>("paint");
  const [drawPickerOpen, setDrawPickerOpen] = useState(false);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  /** Wheel movement banked towards the next step along the tool bar. */
  const wheelRef = useRef({ accumulated: 0, movedAt: 0, steppedAt: 0 });
  const [sprayColor, setSprayColor] = useState(SPRAY_COLORS[0]);
  const [tagImage, setTagImage] = useState<{
    texture: THREE.Texture;
    aspect: number;
    name: string;
    imageRid: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createPickerOpen, setCreatePickerOpen] = useState(false);
  /** The character screen, opened with H. */
  const [characterOpen, setCharacterOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>("build");
  const [objectReadyAt, setObjectReadyAt] = useState(0);
  const [doorReadyAt, setDoorReadyAt] = useState(0);
  /** Progress of the current erase hold, 0..1, for the on-screen indicator. */
  const [eraseProgress, setEraseProgress] = useState(0);
  const eraseRef = useRef<{ id: string | null; elapsed: number; lastAt: number }>({
    id: null,
    elapsed: 0,
    lastAt: 0,
  });
  /**
   * The flatten sweep in progress: the height it is levelling to, and every
   * pad laid so far. Null between presses. Committed as one mark when the
   * trigger comes up, and previewed locally until then.
   */
  const flattenRef = useRef<{ level: number; pads: Array<[number, number]> } | null>(null);
  const [wetPads, setWetPads] = useState<FlatPad[]>([]);
  const [cubeColor, setCubeColor] = useState<string>(DEFAULT_CUBE_COLOR);
  /** How solid the next cube will be. Stored on the mark, so it travels. */
  const [cubeOpacity, setCubeOpacity] = useState<number>(DEFAULT_CUBE_OPACITY);
  const [tagReadyAt, setTagReadyAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [toast, setToast] = useState<string | null>(null);
  /**
   * The stroke being sprayed right now. Rendered locally so painting feels
   * instant, then committed as one mark when the trigger is released.
   */
  const [wetStroke, setWetStroke] = useState<PaintStroke | null>(null);
  const wetRef = useRef<{ color: string; dabs: Dab[] } | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [muted, setMutedState] = useState(() => isMuted());
  /**
   * The local camera pose, sampled every frame. Presence keeps its own copy
   * internally; chat needs one as well, for the distance gate.
   */
  const localPoseRef = useRef<Pose | null>(null);
  const impactCounter = useRef(0);
  const paintCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionIdRef = useRef<string>(crypto.randomUUID());
  /**
   * Label shown above this player's avatar. Starts from the cached name (or an
   * anonymous one) so there is never a blank, then upgrades to the signed in
   * user's real name once the Admin API answers.
   */
  const [playerName, setPlayerName] = useState<string>(
    () => cachedDisplayName() ?? anonymousName(),
  );
  /**
   * Whether playerName is the signed in user's real name yet, rather than the
   * anonymous stand-in shown until the Admin API answers.
   *
   * A personal room is owned by the name in its key, so judging ownership
   * before the real name is known tells people their own room is not theirs —
   * which is what happened on any browser without a cached name. A cached
   * name counts immediately; a lookup that fails never counts, and ownership
   * then simply is not enforced, which is the friendlier way to be wrong.
   */
  const [nameKnown, setNameKnown] = useState(() => cachedDisplayName() != null);

  useEffect(() => {
    let cancelled = false;
    void fetchDisplayName().then((name) => {
      if (cancelled || name == null) {
        return;
      }
      setPlayerName(name);
      setNameKnown(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Browsers refuse synthesised speech until the page has been interacted
  // with. There is always a gesture to hand here — you have to click to lock
  // the pointer before you can move — so prime on the first one.
  useEffect(() => {
    const prime = (): void => primeSpeech();
    window.addEventListener("pointerdown", prime, { once: true });
    return () => window.removeEventListener("pointerdown", prime);
  }, []);

  /**
   * Always attempt pointer lock, even when embedded.
   *
   * Whether an iframe may capture the cursor depends on the host granting the
   * feature, and hosts differ — so this is detected rather than assumed: the
   * app tries, watches for a refusal, and only then falls back to drag-look.
   * There is nothing on screen about any of it: it either works, or dragging
   * to look quietly takes over.
   */
  const [mode, setMode] = useState<ControlMode>("lock");
  const [lockBlocked, setLockBlocked] = useState(false);

  // An explicit refusal (sandboxed iframe, permissions policy) lands here.
  useEffect(() => {
    const handleLockError = (): void => {
      setMode("drag");
      setLockBlocked(true);
    };
    document.addEventListener("pointerlockerror", handleLockError);
    return () => document.removeEventListener("pointerlockerror", handleLockError);
  }, []);

  /**
   * Not every refusal fires pointerlockerror — some hosts simply do nothing.
   * So after a click on the canvas, check whether the cursor was actually
   * captured, and fall back if it was not.
   */
  useEffect(() => {
    if (mode !== "lock" || lockBlocked) {
      return;
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof HTMLCanvasElement)) {
        return;
      }
      window.setTimeout(() => {
        if (document.pointerLockElement == null) {
          setMode("drag");
          setLockBlocked(true);
        }
      }, 600);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [mode, lockBlocked]);

  const current = stack.length > 0 ? stack[stack.length - 1] : null;
  const levelKey = current?.rid ?? "hub";

  /**
   * A personal room belongs to whoever's door leads into it. Anyone may visit
   * and look around, but only the owner can change anything in there.
   *
   * Ownership is read straight back out of the room key, so it cannot drift
   * from the room. Everywhere else — the hub, the filesystem, DechoWorld —
   * stays communal.
   */
  const roomOwner = myspaceOwner(levelKey);
  const canEdit = roomOwner == null || !nameKnown || roomOwner === playerName;

  /**
   * What the Player actually acts with. The bar groups related things under
   * one slot, so the weapon comes from the tool plus whichever mode it is in:
   * Draw is paint or tag, and Create is a door when that is what is selected.
   *
   * Derived rather than stored so the two can never disagree.
   */
  const weapon: WeaponId =
    tool === "draw"
      ? drawMode === "tag"
        ? "tag"
        : "paint"
      : tool === "create"
        ? createMode === "door"
          ? "myspace"
          : "create"
        : tool;

  // Paint lives on the [AP] Server State stream, scoped to this room.
  const {
    paint,
    strokes,
    tags,
    objects,
    doors,
    craters,
    cubes,
    pads,
    addStroke,
    addTag,
    addObject,
    placeDoor,
    addCrater,
    addCube,
    addSweep,
    registerImage,
    removeMarks,
    imageLibrary,
    status: syncStatus,
    error: syncError,
    markCount,
  } = useMarkSync({
    levelKey,
    sessionId: sessionIdRef.current,
    userId: playerName,
    readOnly: !canEdit,
  });
  // Live positions of everyone else, on their own throwaway stream.
  const {
    players,
    tracksRef,
    playbackDelayRef,
    reportPose,
    enabled: presenceEnabled,
    link: presenceLink,
    stats: presenceStats,
  } = usePresence({
    levelKey,
    sessionId: sessionIdRef.current,
    userId: playerName,
    weapon,
  });
  /** Feeds the per-frame pose to presence, and keeps a copy for chat. */
  const handlePose = useCallback(
    (pose: Pose) => {
      localPoseRef.current = pose;
      reportPose(pose);
    },
    [reportPose],
  );
  /**
   * Everyone's chosen appearance, and this player's own.
   *
   * Kept whole rather than per room: what you look like follows you about, and
   * the same read serves your own avatar and everybody else's.
   */
  const character = useCharacter({ userId: playerName });
  /**
   * What the character screen is showing, which leads the saved value while it
   * is open so the preview responds to every click. Published on close, so a
   * session of fiddling is one record rather than one per click.
   */
  const [draftAppearance, setDraftAppearance] = useState<Appearance | null>(null);
  /**
   * What the screen is showing: the draft while one is being made, otherwise
   * whatever is saved.
   *
   * Only the preview needs this. The world does not, because the only avatars
   * drawn are other players' — you cannot see your own from behind your own
   * eyes, which is the whole reason the preview exists.
   */
  const appearance = draftAppearance ?? character.mine;

  /** Mirror of the draft, so closing can read it without being a state updater. */
  const draftRef = useRef<Appearance | null>(null);
  draftRef.current = draftAppearance;

  const closeCharacter = useCallback(() => {
    setCharacterOpen(false);
    // Deliberately not inside a setState updater: React may run an updater
    // twice in development, and publishing twice is a record twice.
    const draft = draftRef.current;
    if (draft != null) {
      character.save(draft);
    }
    setDraftAppearance(null);
  }, [character]);

  // Proximity chat, on its own stream so it never replays history.
  const chat = useChat({
    levelKey,
    sessionId: sessionIdRef.current,
    userId: playerName,
    poseRef: localPoseRef,
    tracksRef,
  });
  /**
   * Bumps when a model's geometry finishes loading. Footprints are measured
   * from that geometry, so collision has to be re-derived once it arrives —
   * otherwise a freshly loaded prop keeps its placeholder box until something
   * unrelated happens to invalidate the memo.
   */
  const modelsVersion = useSyncExternalStore(subscribeModelLoads, modelLoadVersion);

  /** Collision boxes for the props standing in this room. */
  const propBoxes = useMemo(() => {
    // Referenced only to re-derive when a model's measured footprint arrives:
    // obstacleFor reads footprints from the library, not from these inputs,
    // so nothing else here would change when a load completes.
    void modelsVersion;
    return objects.map(obstacleFor);
  }, [objects, modelsVersion]);

  const playersHere = useMemo(
    () => players.filter((player) => player.levelKey === levelKey),
    [players, levelKey],
  );

  const inHub = current == null;
  const inSpacesList = current?.kind === "spaces";
  const inMyspace = current?.kind === "myspace";
  const inWorld = current?.kind === "world";
  /**
   * DechoWorld 2: the same world in every respect the game cares about — you
   * can build, dig and level in it exactly as in the first — except that its
   * ground is a real DEM read out of Foundry rather than noise.
   */
  const inGeoWorld = levelKey === WORLD2_LEVEL_KEY;
  /** Personal rooms are much smaller than the filesystem arena. */
  const roomHalfSize = inMyspace ? MYSPACE_HALF_SIZE : ARENA_HALF_SIZE;

  /**
   * Whether this room is one you may build in at all: cubes, props, doors and
   * — in DechoWorld — the terrain verbs.
   *
   * A property of the room, not of the player: whether *this* player may build
   * in it is canEdit below, which is about who owns a personal room. Somewhere
   * you cannot build, the Create tool is not offered rather than offered and
   * refused, so the bar never carries a slot that does nothing.
   */
  const canBuild = inMyspace || inWorld;

  /**
   * True while a chooser is open. The pointer stays locked either way — the
   * game draws its own cursor rather than handing the real one back — so this
   * is what tells the player to stop looking and firing.
   */
  const menuOpen =
    pickerOpen || createPickerOpen || drawPickerOpen || colorMenuOpen || characterOpen;

  /** Create appears only where it works, and the eraser always sits last. */
  const tools = useMemo(
    () => (canBuild ? [...BASE_TOOLS, CREATE_TOOL, ERASER_TOOL] : [...BASE_TOOLS, ERASER_TOOL]),
    [canBuild],
  );

  /**
   * The world the player collides against: cubes indexed by cell, plus the
   * generated terrain minus anything dug out of it.
   */
  /**
   * Committed pads plus the sweep in progress, so the ground levels under the
   * crosshair as you sweep rather than only once you let go.
   */
  const allPads = useMemo(
    () => (wetPads.length === 0 ? pads : [...pads, ...wetPads]),
    [pads, wetPads],
  );

  /**
   * Terrain height, indexed by the edits that reach each point.
   *
   * Rebuilt whenever anything is dug or levelled, which is rare, and then
   * called a couple of hundred times a frame by the collision sweep — so the
   * index is paid for many times over the first time anyone walks.
   */
  /**
   * DechoWorld 2's ground, once it has been read out of Foundry.
   *
   * Held here rather than fetched on arrival: the load is awaited at the door
   * (see the portal in handleShoot), so by the time the room is on screen this
   * is set and the mesh, the footing and everyone else's avatars agree from the
   * first frame. A world that loaded in underneath the player would put them at
   * the wrong height — visibly, to every other player in the room.
   */
  const [geo, setGeo] = useState<GeoTerrain | null>(null);
  const [entering, setEntering] = useState(false);
  const [enterError, setEnterError] = useState<string | null>(null);

  /**
   * Which world this is. The two differ only in where the ground comes from,
   * how it is coloured, how far you can see and where the sea sits.
   *
   * The view reaches further in DechoWorld 2 because there is something out
   * there to see: real mountains are kilometres away, and the procedural
   * world's 450 m of visibility would hide every one of them.
   */
  const terrain: TerrainStyle = useMemo(
    () =>
      inGeoWorld && geo != null
        ? {
            id: "geo",
            base: geo.height,
            color: geo.color,
            viewRadius: 5,
            // The world is shifted so the spawn stands at zero, and the sea
            // has to move down with it or the fjord would flood the village.
            seaLevel: -geo.datum,
          }
        : PROCEDURAL_TERRAIN,
    [inGeoWorld, geo],
  );

  /** False only in the moment before the DEM-backed world has its ground. */
  const worldReady = !inGeoWorld || geo != null;

  const terrainSampler = useMemo(
    () => buildTerrainSampler(craters, allPads, terrain.base),
    [craters, allPads, terrain],
  );

  /**
   * What the basemap says is on the ground around DechoWorld 2's spawn: the
   * roads, the blocks and parks they run between, and the buildings on those
   * blocks.
   *
   * Not gated at the door the way the ground itself is. The ground has to be
   * right before anyone stands on it; scenery can arrive a moment later, and a
   * failure costs the scenery rather than the world.
   */
  const geoOrigin = geo?.origin;
  const surfaceQuery = useQuery({
    queryKey: ["geo-surface", geoOrigin?.lon, geoOrigin?.lat],
    queryFn: async () => (geoOrigin == null ? null : loadSurface(geoOrigin)),
    enabled: inGeoWorld && geoOrigin != null,
    staleTime: Infinity,
  });
  const surface = surfaceQuery.data ?? null;

  /**
   * Buildings as solid boxes, so you walk round them rather than through them.
   *
   * Their base is sunk below the ground and their top is the roof, which means
   * the sweep treats them as props rather than as walls floor to ceiling: you
   * cannot pass under one, and anything that gets you above one can stand on
   * it.
   */
  const buildingBoxes = useMemo(
    () =>
      (surface?.buildings ?? []).map((building) => ({
        x: building.x,
        z: building.z,
        yaw: 0,
        halfX: building.halfX,
        halfZ: building.halfZ,
        yMin: terrain.base(building.x, building.z) - 3,
        yMax: terrain.base(building.x, building.z) + building.height,
      })),
    [surface, terrain],
  );

  const voxelWorld = useMemo(
    () => ({
      voxels: buildVoxelMap(cubes),
      // Flat rooms get a world of the same shape with the terrain held flat at
      // zero. The arena floor is then just a very boring height field, and
      // there is one collision path everywhere rather than a second, simpler
      // one that has to re-earn step-up, landing and edge protection.
      terrainAt: inWorld && worldReady ? terrainSampler : () => 0,
      // Props only: cubes are already voxels here, and feeding them in twice
      // would just have the swept collision find the same tops again. The
      // buildings join them in DechoWorld 2, being the same thing physically:
      // a box on the ground with a top.
      props: buildingBoxes.length === 0 ? propBoxes : [...propBoxes, ...buildingBoxes],
    }),
    [cubes, terrainSampler, propBoxes, buildingBoxes, inWorld, worldReady],
  );

  /**
   * The model pack, listed from the dataset once per session. An empty list
   * on failure is fine: the picker still offers the two built-in props.
   */
  const modelsQuery = useQuery({
    queryKey: ["object-models"],
    queryFn: listObjectModels,
    staleTime: Infinity,
  });
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);

  const spacesQuery = useQuery({
    queryKey: ["spaces"],
    queryFn: listSpaces,
    enabled: inSpacesList,
    staleTime: 5 * 60 * 1000,
  });

  const childrenQuery = useQuery({
    queryKey: ["children", current?.rid],
    queryFn: () => listChildren(current?.rid as string),
    // A personal room is not a Compass folder, so there is nothing to list.
    enabled: current != null && !inSpacesList && !inMyspace && !inWorld,
    staleTime: 5 * 60 * 1000,
  });

  /** Everything in the current filesystem level, normalised to a common shape. */
  const nodes: FsNode[] = useMemo(() => {
    if (inHub || inMyspace || inWorld) {
      return [];
    }
    if (inSpacesList) {
      return (spacesQuery.data ?? []).map((space) => ({
        rid: space.rid,
        name: space.name,
        path: space.path,
        type: "SPACE",
        isFolder: true,
      }));
    }
    return childrenQuery.data ?? [];
  }, [inHub, inMyspace, inWorld, inSpacesList, spacesQuery.data, childrenQuery.data]);

  const targets: TargetSpec[] = useMemo(() => {
    if (inHub) {
      return buildHubTargets(APP_LINKS);
    }
    return scatterTargets(
      nodes.map((node) => ({
        rid: node.rid,
        name: node.name,
        caption: inSpacesList
          ? "Space"
          : node.isFolder
            ? current?.kind === "space"
              ? "Project"
              : "Folder"
            : humanizeType(node.type),
        color: node.isFolder ? undefined : colorForType(node.type),
        enterable: node.isFolder,
      })),
      levelKey,
    );
  }, [inHub, inSpacesList, nodes, current?.kind, levelKey]);

  const push = useCallback((crumb: Crumb) => {
    setStack((previous) => [...previous, crumb]);
    setImpacts([]);
    setDetail(null);
  }, []);

  const goBack = useCallback(() => {
    setStack((previous) => previous.slice(0, -1));
    setImpacts([]);
    setDetail(null);
  }, []);

  const goToHub = useCallback(() => {
    setStack([]);
    setImpacts([]);
    setDetail(null);
  }, []);

  /** Where the currently open info panel points, if anywhere. */
  const detailUrl = useMemo(() => {
    if (detail == null) {
      return null;
    }
    return detail.type === "app"
      ? detail.app.url
      : `${foundryUrl}/workspace/compass/view/${detail.node.rid}`;
  }, [detail]);

  // 1 / 2 / 3 / 4 swap tools, C uploads or cycles colour, V opens the tag
  // gallery, P toggles presence smoothing, B walks back up one level and F
  // follows the link in the open panel.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // While the composer owns the keyboard, no tool, colour or navigation
      // binding may fire. Player is gated the same way, via inputCaptured.
      if (chatOpen) {
        return;
      }

      // A picker owns the keyboard, and the tag picker's import field accepts
      // paths — which contain slashes. So bail out before preventDefault,
      // rather than swallowing the keystroke.
      const modalOpen = pickerOpen || createPickerOpen;

      // "/" opens the composer. Matched on e.key rather than e.code so it
      // still works on layouts where slash is not the "Slash" key, and
      // prevented so Firefox does not open quick-find and so the character
      // itself never lands in the box we are about to focus.
      if (e.key === "/") {
        if (modalOpen) {
          return;
        }
        e.preventDefault();
        if (!e.repeat) {
          setChatOpen(true);
        }
        return;
      }

      // H opens the character screen. It closes itself, in its own capture
      // phase handler, so there is nothing to toggle here.
      if (e.code === "KeyH" && !modalOpen) {
        setCharacterOpen(true);
        return;
      }

      if (e.code === "KeyM" && !modalOpen) {
        const next = !muted;
        setSpeechMuted(next);
        setMutedState(next);
        setToast(next ? "Chat audio muted" : "Chat audio unmuted");
        return;
      }

      // Number keys index the visible tool list, which varies by room.
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit != null) {
        const picked = tools[Number(digit[1]) - 1];
        if (picked != null) {
          setTool(picked.id);
        }
      }
      // F is the options chooser for whatever tool is in hand.
      if (e.code === "KeyF") {
        if (tool === "create") {
          setCreatePickerOpen(true);
        } else if (tool === "draw") {
          setDrawPickerOpen(true);
        }
      }

      // C picks what the tool works with: a colour, or which tag to paste.
      if (e.code === "KeyC") {
        if (tool === "draw" && drawMode === "tag") {
          setPickerOpen(true);
        } else if (
          (tool === "draw" && drawMode === "paint") ||
          (tool === "create" && createMode === "build")
        ) {
          setColorMenuOpen(true);
        }
      }
      if (e.code === "KeyB") {
        goBack();
      }
      // Enter follows the open panel's link. F used to, before it became the
      // options chooser.
      if (e.code === "Enter" && detailUrl != null) {
        window.open(detailUrl, "_blank", "noopener,noreferrer");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    goBack,
    detailUrl,
    tool,
    tools,
    drawMode,
    createMode,
    chatOpen,
    pickerOpen,
    createPickerOpen,
    muted,
  ]);

  /**
   * The scroll wheel cycles tools, so the whole bar is reachable without
   * taking a hand off the mouse. Ignored while a chooser or the chat composer
   * owns the screen.
   *
   * Stepping on every event is unusable: a trackpad or a smooth-scrolling
   * mouse fires dozens of small deltas for one flick, which ran through the
   * whole bar several times over. So deltas accumulate to a threshold, there
   * is a short cooldown after each step, and a pause starts the count again
   * rather than letting one gesture inherit leftovers from the last.
   */
  useEffect(() => {
    const handleWheel = (e: WheelEvent): void => {
      if (chatOpen || menuOpen || e.deltaY === 0) {
        return;
      }

      const now = Date.now();
      const wheel = wheelRef.current;
      if (now - wheel.steppedAt < WHEEL_COOLDOWN_MS) {
        return;
      }
      if (now - wheel.movedAt > WHEEL_IDLE_MS) {
        wheel.accumulated = 0;
      }
      wheel.movedAt = now;

      // Line and page modes report far smaller numbers than pixels do.
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      wheel.accumulated += e.deltaY * scale;
      if (Math.abs(wheel.accumulated) < WHEEL_STEP) {
        return;
      }

      const step = wheel.accumulated > 0 ? 1 : -1;
      wheel.accumulated = 0;
      wheel.steppedAt = now;

      setTool((previous) => {
        const at = tools.findIndex((entry) => entry.id === previous);
        return tools[(at + step + tools.length) % tools.length].id;
      });
    };
    window.addEventListener("wheel", handleWheel, { passive: true });
    return () => window.removeEventListener("wheel", handleWheel);
  }, [tools, chatOpen, menuOpen]);

  // Digging and levelling only mean anything where there is terrain; leaving
  // DechoWorld with one selected would give a tool that silently does nothing.
  // The mode is kept rather than the tool: blocks work in every room that can
  // be built in at all.
  useEffect(() => {
    if (!inWorld && needsTerrain(createMode)) {
      setCreateMode("build");
    }
  }, [inWorld, createMode]);

  // Walking into a room that cannot be built in puts the Create tool away, so
  // the player is never left holding a tool that is no longer on the bar — and
  // closes its chooser, which the number keys could otherwise leave stranded
  // over a room it does not apply to.
  useEffect(() => {
    if (canBuild) {
      return;
    }
    setCreatePickerOpen(false);
    setTool((previous) => (previous === "create" ? "select" : previous));
  }, [canBuild]);

  // Drive the tag and object cooldown readouts.
  useEffect(() => {
    if (Math.max(tagReadyAt, objectReadyAt, doorReadyAt) <= Date.now()) {
      return;
    }
    const interval = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [tagReadyAt, objectReadyAt, doorReadyAt]);

  // Let the erase indicator fade out when the trigger is released.
  useEffect(() => {
    if (eraseProgress === 0) {
      return;
    }
    const interval = window.setInterval(() => {
      if (Date.now() - eraseRef.current.lastAt > ERASE_RESET_MS) {
        eraseRef.current.id = null;
        eraseRef.current.elapsed = 0;
        setEraseProgress(0);
      }
    }, 80);
    return () => window.clearInterval(interval);
  }, [eraseProgress]);

  // Auto-dismiss the little status toast.
  useEffect(() => {
    if (toast == null) {
      return;
    }
    // Probe results are dense and worth reading; ordinary toasts are not.
    const timeout = window.setTimeout(
      () => setToast(null),
      toast.startsWith("probe:") ? 20000 : 2500,
    );
    return () => window.clearTimeout(timeout);
  }, [toast]);

  /**
   * Decodes the picked image for an instant preview and uploads it to the
   * [AP] tags media set. Only the resulting media item RID travels on the
   * stream; everyone else downloads the image from the media set.
   */
  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file == null) {
        return;
      }
      if (!isPng(file)) {
        setToast("PNG images only");
        return;
      }

      setUploading(true);
      setToast(`Uploading ${file.name}…`);

      void (async () => {
        try {
          const [{ texture, aspect }, imageRid] = await Promise.all([
            readLocalImage(file),
            uploadTagImage(file),
          ]);
          setTagImage({ texture, aspect, name: file.name, imageRid });
          registerImage(imageRid);
          setToast(`Loaded ${file.name} — click to paste it`);
        } catch {
          setToast("Could not upload that image to the tags media set");
        } finally {
          setUploading(false);
        }
      })();
    },
    [registerImage],
  );

  /** Loads an image that is already in the media set into the tag tool. */
  const handlePickImage = useCallback((imageRid: string) => {
    setPickerOpen(false);
    setUploading(true);
    void (async () => {
      try {
        const [{ texture, aspect }, name] = await Promise.all([
          loadTagTexture(imageRid),
          getTagImageName(imageRid).catch(() => "tag"),
        ]);
        setTagImage({ texture, aspect, name, imageRid });
        setDrawMode("tag");
        setTool("draw");
        setToast(`Loaded ${name} — click to paste it`);
      } catch {
        setToast("Could not load that image");
      } finally {
        setUploading(false);
      }
    })();
  }, []);

  /**
   * Adds an image that was already in the media set (uploaded outside this
   * app) to the library by resolving its path to a media item RID.
   */
  const handleImportPath = useCallback(
    (mediaItemPath: string) => {
      setToast(`Looking for ${mediaItemPath}…`);
      void (async () => {
        try {
          const imageRid = await findMediaItemByPath(mediaItemPath);
          if (imageRid == null) {
            setToast(`No media item at "${mediaItemPath}"`);
            return;
          }
          registerImage(imageRid);
          setToast(`Added ${mediaItemPath} to the library`);
        } catch {
          setToast(`Could not look up "${mediaItemPath}"`);
        }
      })();
    },
    [registerImage],
  );

  const handleShoot = useCallback(
    (shot: ShotResult) => {
      // Nudge the decal off the surface so it does not z-fight.
      const point = shot.point.clone().add(shot.normal.clone().multiplyScalar(0.02));

      // Someone else's personal room: look all you like, but leave it as you
      // found it. "fire" is the select tool, which only opens things, so it
      // stays available.
      if (!canEdit && shot.action !== "fire") {
        setToast(`${roomOwner}'s room — only they can change it`);
        return;
      }

      // Spray can: stick a disc of paint on whatever the crosshair is over.
      if (shot.action === "spray") {
        const seed = (paintCounter.current += 1);
        const { spread, angle, size } = sprayJitter(seed);
        const quaternion = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          shot.normal,
        );
        // Offset inside the surface plane so repeated ticks build up a cone.
        const tangent = new THREE.Vector3(1, 0, 0)
          .applyQuaternion(quaternion)
          .multiplyScalar(Math.cos(angle) * spread);
        const bitangent = new THREE.Vector3(0, 1, 0)
          .applyQuaternion(quaternion)
          .multiplyScalar(Math.sin(angle) * spread);
        const blobPoint = point.clone().add(tangent).add(bitangent);

        // Dabs accumulate into the stroke in progress and are committed as a
        // single mark when the trigger comes up. The ref is the source of
        // truth, not the state: a release batched together with the last tick
        // would otherwise read a stale value and lose the stroke.
        const dab: Dab = {
          position: [blobPoint.x, blobPoint.y, blobPoint.z],
          quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
          radius: size,
        };

        const wet = wetRef.current;
        if (wet != null && wet.color !== sprayColor) {
          // Colour changed mid-press: bank what is there and start again.
          addStroke(wet.color, wet.dabs);
          wetRef.current = null;
        }
        if (wetRef.current == null) {
          wetRef.current = { color: sprayColor, dabs: [] };
        }
        if (wetRef.current.dabs.length >= MAX_STROKE_DABS) {
          // A very long press splits across consecutive records rather than
          // growing one unbounded row.
          addStroke(wetRef.current.color, wetRef.current.dabs);
          wetRef.current = { color: sprayColor, dabs: [] };
        }
        wetRef.current.dabs.push(dab);
        setWetStroke({
          id: "wet",
          color: wetRef.current.color,
          dabs: [...wetRef.current.dabs],
        });
        return;
      }

      // Tag: paste the uploaded image, scaled to fit a fixed square.
      if (shot.action === "tag") {
        if (tagImage == null) {
          setToast("Press F to upload a PNG, or C to pick one");
          return;
        }
        if (Date.now() < tagReadyAt) {
          return;
        }

        const quaternion = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          shot.normal,
        );
        const width = tagImage.aspect >= 1 ? TAG_FIT : TAG_FIT * tagImage.aspect;
        const height = tagImage.aspect >= 1 ? TAG_FIT / tagImage.aspect : TAG_FIT;

        addTag({
          position: [point.x, point.y, point.z],
          quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
          width,
          height,
          imageRid: tagImage.imageRid,
          texture: tagImage.texture,
        });
        setTagReadyAt(Date.now() + TAG_COOLDOWN_MS);
        setNow(Date.now());
        return;
      }

      // MySpace: put down this player's door into their personal room.
      if (shot.action === "door") {
        if (Date.now() < doorReadyAt) {
          return;
        }
        if (shot.normal.y < FLOOR_NORMAL_MIN_Y) {
          setToast("Doors need level ground");
          return;
        }
        placeDoor([shot.point.x, shot.point.y, shot.point.z], shot.cameraYaw);
        setDoorReadyAt(Date.now() + DOOR_COOLDOWN_MS);
        setNow(Date.now());
        setToast("Door placed — any earlier one has been removed");
        return;
      }

      // Create: a prop, a hollow, or a cube, depending on the chosen mode.
      if (shot.action === "create") {
        if (createMode === "build") {
          const cell = snapToCell(shot.point, shot.normal);
          if (!cubes.some((cube) => sameCell(cube, cell))) {
            addCube(cell.x, cell.y, cell.z, cubeColor, cubeOpacity);
          }
          return;
        }

        if (createMode === "dig") {
          addCrater(shot.point.x, shot.point.z, DIG_RADIUS, DIG_DEPTH);
          return;
        }

        /*
         * Restore: undo the terrain edits the crosshair is standing on.
         *
         * Matched against each edit's own radius rather than a fixed one, so
         * pointing anywhere on a hollow or a levelled patch takes that whole
         * edit back — which is what "put this bit of ground back" means when
         * the edits differ in size. Repeated digs overlap, so several can go
         * at once, and a sweep goes whole for the same reason a stroke does.
         */
        if (createMode === "restore") {
          const covers = (x: number, z: number, radius: number): boolean => {
            const dx = x - shot.point.x;
            const dz = z - shot.point.z;
            return dx * dx + dz * dz <= radius * radius;
          };

          const restored = [
            ...craters
              .filter((crater) => covers(crater.x, crater.z, crater.radius))
              .map((crater) => crater.id),
            ...Array.from(
              new Set(
                pads.filter((pad) => covers(pad.x, pad.z, pad.radius)).map((pad) => pad.markId),
              ),
            ),
          ];

          if (restored.length > 0) {
            removeMarks(restored);
          }
          return;
        }

        if (createMode === "flatten") {
          const sweep = flattenRef.current;

          // No sweep in progress means this is the first tick of the press,
          // and the height under the crosshair right now is what the whole
          // sweep levels to. The trigger release ends it.
          if (sweep == null) {
            flattenRef.current = {
              level: shot.point.y,
              pads: [[shot.point.x, shot.point.z]],
            };
            setWetPads(padsFromSweep(flattenRef.current));
            return;
          }

          // One pad per step of aim movement, rather than one per tick.
          const last = sweep.pads[sweep.pads.length - 1];
          if (Math.hypot(shot.point.x - last[0], shot.point.z - last[1]) <= FLATTEN_STEP) {
            return;
          }

          let active = sweep;
          if (active.pads.length >= MAX_SWEEP_PADS) {
            // A very long sweep splits across consecutive records rather than
            // growing one unbounded row.
            addSweep(active.level, FLATTEN_RADIUS, active.pads);
            active = { level: active.level, pads: [] };
            flattenRef.current = active;
          }

          active.pads.push([shot.point.x, shot.point.z]);
          setWetPads(padsFromSweep(active));
          return;
        }

        // Props: on level ground only, facing whoever placed them. Anything
        // that reaches here is a prop, since every terrain verb returned above.
        if (Date.now() < objectReadyAt) {
          return;
        }
        if (shot.normal.y < FLOOR_NORMAL_MIN_Y) {
          setToast("Props need level ground");
          return;
        }
        addObject({
          kind: createMode,
          position: [shot.point.x, shot.point.y, shot.point.z],
          yaw: shot.cameraYaw,
        });
        setObjectReadyAt(Date.now() + OBJECT_COOLDOWN_MS);
        setNow(Date.now());
        return;
      }

      // Eraser. Surface marks wipe off immediately; solid things — cubes and
      // props — need the aim held on them, so a stray sweep past someone's
      // build does not delete it.
      if (shot.action === "clean") {
        const distanceSquared = (position: [number, number, number]): number => {
          const dx = position[0] - shot.point.x;
          const dy = position[1] - shot.point.y;
          const dz = position[2] - shot.point.z;
          return dx * dx + dy * dy + dz * dz;
        };
        const near = (position: [number, number, number]): boolean =>
          distanceSquared(position) <= MOP_RADIUS * MOP_RADIUS;

        // Surfaces only. Digging and levelling are not marks on a surface but
        // changes to the shape of the world, and taking one back moves the
        // ground under whoever is standing on it — too much to happen because
        // somebody swept an eraser past. Create's restore tool does that
        // instead, deliberately and only where there is terrain.
        removeMarks([
          ...paint.filter((blob) => near(blob.position)).map((blob) => blob.id),
          // A stroke is one object, so touching any part of it takes all of
          // it — the same way cubes and props erase whole.
          ...strokes
            .filter((stroke) => stroke.dabs.some((dab) => near(dab.position)))
            .map((stroke) => stroke.id),
          ...tags.filter((tag) => near(tag.position)).map((tag) => tag.id),
        ]);

        // Whichever solid is closest to the aim point is the one being erased.
        const solids: Array<{ id: string; distance: number }> = [
          ...objects.map((object) => ({
            id: object.id,
            distance: distanceSquared(object.position),
          })),
          ...cubes.map((cube) => ({
            id: cube.id,
            distance: distanceSquared([cube.x, cube.y, cube.z]),
          })),
        ].filter((candidate) => candidate.distance <= MOP_RADIUS * MOP_RADIUS);
        solids.sort((a, b) => a.distance - b.distance);
        const target = solids.length > 0 ? solids[0] : null;

        const holding = eraseRef.current;
        const now = Date.now();
        if (target == null) {
          holding.id = null;
          holding.elapsed = 0;
          setEraseProgress(0);
          return;
        }

        const gap = now - holding.lastAt;
        // A different target, or a pause, starts the hold again.
        if (holding.id !== target.id || gap > ERASE_RESET_MS) {
          holding.id = target.id;
          holding.elapsed = 0;
        }
        holding.elapsed += Math.min(gap, ERASE_TICK_MS);
        holding.lastAt = now;

        if (holding.elapsed >= ERASE_HOLD_MS) {
          removeMarks([target.id]);
          holding.id = null;
          holding.elapsed = 0;
          setEraseProgress(0);
          return;
        }
        setEraseProgress(holding.elapsed / ERASE_HOLD_MS);
        return;
      }

      setImpacts((previous) => [
        ...previous.slice(-24),
        {
          id: `impact-${(impactCounter.current += 1)}`,
          position: [point.x, point.y, point.z],
        },
      ]);

      if (shot.targetId == null) {
        return;
      }

      // A door leads into its owner's personal room.
      if (shot.targetId.startsWith(DOOR_TARGET_PREFIX)) {
        const door = doors.find(
          (candidate) => `${DOOR_TARGET_PREFIX}${candidate.id}` === shot.targetId,
        );
        if (door == null) {
          return;
        }
        setHitTargetId(shot.targetId);
        window.setTimeout(() => setHitTargetId(null), 220);
        window.setTimeout(
          () =>
            push({
              rid: myspaceLevelKey(door.userId),
              name: `${door.userId}'s Space`,
              kind: "myspace",
            }),
          180,
        );
        return;
      }

      const target = targets.find((candidate) => candidate.id === shot.targetId);
      if (target == null) {
        return;
      }

      setHitTargetId(target.id);
      window.setTimeout(() => setHitTargetId(null), 220);

      // Hub: either the portal into the filesystem or an application block.
      if (target.kind === "app") {
        const app = APP_LINKS.find((candidate) => candidate.id === target.rid);
        if (app != null) {
          // Never navigate on the shot itself: the panel offers a link and F.
          setDetail({ type: "app", app });
        }
        return;
      }

      if (target.rid === WORLD_PORTAL_RID) {
        window.setTimeout(
          () => push({ rid: WORLD_LEVEL_KEY, name: "DechoWorld", kind: "world" }),
          180,
        );
        return;
      }

      if (target.rid === WORLD2_PORTAL_RID) {
        /**
         * The door waits for the ground.
         *
         * The DEM cell behind it is a few megabytes, and it is the only thing
         * in the game that cannot be loaded in underneath the player: terrain
         * is never synchronised, so a client standing on ground that has not
         * arrived yet is a client standing at a height nobody else agrees
         * with. One wait at the door buys 220 km in every direction.
         */
        setEnterError(null);
        setEntering(true);
        void loadGeoTerrain()
          .then((loaded) => {
            setGeo(loaded);
            setEntering(false);
            push({ rid: WORLD2_LEVEL_KEY, name: "DechoWorld 2", kind: "world" });
          })
          .catch((err: unknown) => {
            setEntering(false);
            setEnterError(`Could not read the elevation data: ${describeError(err)}`);
          });
        return;
      }

      if (target.rid === SPACES_PORTAL_RID) {
        window.setTimeout(
          () => push({ rid: SPACES_PORTAL_RID, name: "Spaces", kind: "spaces" }),
          180,
        );
        return;
      }

      const node = nodes.find((candidate) => candidate.rid === target.rid);
      if (node == null) {
        return;
      }

      if (!node.isFolder) {
        setDetail({ type: "resource", node });
        return;
      }

      const kind: Crumb["kind"] = inSpacesList
        ? "space"
        : current?.kind === "space"
          ? "project"
          : "folder";
      window.setTimeout(() => push({ rid: node.rid, name: node.name, kind }), 180);
    },
    [
      targets,
      nodes,
      inSpacesList,
      current?.kind,
      push,
      sprayColor,
      tagImage,
      tagReadyAt,
      addStroke,
      addTag,
      addObject,
      removeMarks,
      paint,
      strokes,
      tags,
      objects,
      createMode,
      objectReadyAt,
      doors,
      placeDoor,
      doorReadyAt,
      craters,
      addCrater,
      pads,
      addSweep,
      cubes,
      addCube,
      cubeColor,
      cubeOpacity,
      canEdit,
      roomOwner,
    ],
  );

  /** Trigger released: bank whatever was being sprayed or swept, as one mark. */
  const handleTriggerRelease = useCallback(() => {
    const wet = wetRef.current;
    wetRef.current = null;
    if (wet != null && wet.dabs.length > 0) {
      addStroke(wet.color, wet.dabs);
    }
    setWetStroke(null);

    const sweep = flattenRef.current;
    flattenRef.current = null;
    if (sweep != null && sweep.pads.length > 0) {
      addSweep(sweep.level, FLATTEN_RADIUS, sweep.pads);
    }
    setWetPads((previous) => (previous.length === 0 ? previous : []));
  }, [addStroke, addSweep]);

  // Walking out mid-stroke drops it rather than banking it. addStroke and
  // addSweep write against whichever room is current, so committing here
  // would file the work in the room the player just walked into.
  useEffect(() => {
    wetRef.current = null;
    setWetStroke(null);
    flattenRef.current = null;
    setWetPads((previous) => (previous.length === 0 ? previous : []));
  }, [levelKey]);

  const loading = inSpacesList ? spacesQuery.isLoading : !inHub && childrenQuery.isLoading;
  const error = inSpacesList ? spacesQuery.error : childrenQuery.error;
  const empty =
    !inHub && !inMyspace && !inWorld && !loading && error == null && targets.length === 0;

  const activeWeapon = tools.find((entry) => entry.id === tool) ?? tools[0];
  const tagCooldownLeft = Math.max(0, tagReadyAt - now);
  const objectCooldownLeft = Math.max(0, objectReadyAt - now);
  const doorCooldownLeft = Math.max(0, doorReadyAt - now);
  /**
   * Friendly name for whatever the create tool is holding. Model kinds are
   * paths, which would otherwise read as "place a model:furniture/..." in the
   * hint.
   */
  const createLabel = useMemo(() => {
    const path = modelPathOf(createMode);
    if (path == null) {
      return createMode;
    }
    const file = path.slice(path.lastIndexOf("/") + 1);
    return file.replace(/\.glb$/i, "").replace(/[_-]+/g, " ");
  }, [createMode]);
  /**
   * The same label, dressed for the tool bar: capitalised, because the verbs
   * are stored lower case and read as a heading here rather than as part of a
   * sentence, and shortened, because model names are file names and a long one
   * would push the bar wider than the screen.
   */
  const createModeLabel = useMemo(() => {
    const capitalised =
      createLabel.length === 0 ? createLabel : createLabel[0].toUpperCase() + createLabel.slice(1);
    return capitalised.length > MAX_MODE_LABEL
      ? `${capitalised.slice(0, MAX_MODE_LABEL - 1).trimEnd()}…`
      : capitalised;
  }, [createLabel]);
  const weaponHint =
    weapon === "create"
      ? createMode === "build"
        ? "Click a surface to place a cube · F changes mode · C picks colour and opacity"
        : createMode === "dig"
          ? "Click the ground to dig · F changes mode"
          : createMode === "flatten"
            ? "Hold and sweep to level the ground · F changes mode"
            : createMode === "restore"
              ? "Hold and sweep to put the ground back · F changes mode"
              : objectCooldownLeft > 0
                ? `Reloading… ${(objectCooldownLeft / 1000).toFixed(1)}s`
                : `Click the floor to place a ${createLabel} · F changes mode`
      : weapon === "myspace"
        ? doorCooldownLeft > 0
          ? `Reloading… ${Math.ceil(doorCooldownLeft / 1000)}s`
          : "Click the floor to put down your door · F changes mode"
        : weapon === "tag"
          ? uploading
            ? "Working with the tags media set…"
            : tagImage == null
              ? "F to upload · C picks from the gallery"
              : tagCooldownLeft > 0
                ? `Reloading… ${(tagCooldownLeft / 1000).toFixed(1)}s`
                : `Click to paste ${tagImage.name} · C picks another`
          : activeWeapon.hint;
  const crosshairColor =
    weapon === "create"
      ? createMode === "build"
        ? cubeColor
        : createMode === "dig"
          ? "#c8a06a"
          : createMode === "flatten"
            ? "#8fd18f"
            : createMode === "restore"
              ? "#7fd6c4"
              : "#a9743f"
      : weapon === "myspace"
        ? doorCooldownLeft > 0
          ? "#6f6390"
          : "#ff8f4d"
        : weapon === "paint"
          ? sprayColor
          : weapon === "eraser"
            ? "#ffffff"
            : weapon === "tag"
              ? tagCooldownLeft > 0
                ? "#6f6390"
                : "#ffd166"
              : "#a100ff";

  const folderCount = nodes.filter((node) => node.isFolder).length;
  const resourceCount = nodes.length - folderCount;

  const title = inHub ? "FOUNDRY HUB" : inSpacesList ? "ACCENTURE SPACES" : (current?.name ?? "");
  const subtitle = inGeoWorld
    ? "Old Street at 1:1 — real ground, straight out of Foundry"
    : inWorld
      ? "Endless procedural terrain — walk as far as you like"
      : inMyspace
        ? canEdit
          ? "Your room — paint it, furnish it, make it yours"
          : `${roomOwner}'s room — you can look around, but only they can change it`
        : inHub
          ? "Shoot the tall block to enter the filesystem, or an app block to open it"
          : inSpacesList
            ? `${nodes.length} space${nodes.length === 1 ? "" : "s"} — shoot one to drop inside`
            : `${folderCount} enterable · ${resourceCount} resource${resourceCount === 1 ? "" : "s"}`;

  return (
    <div className={css.root}>
      {/*
       * The far plane is set once, for the furthest-seeing room there is:
       * three.js builds the camera when the canvas mounts, and DechoWorld 2's
       * horizon is past where 400 m would clip it. Fog closes in long before
       * this in every room, so nothing else changes.
       */}
      <Canvas camera={{ position: [0, 1.7, 0], fov: 75, far: 1400 }}>
        {inWorld ? (
          <DaylightSky terrain={terrain} />
        ) : (
          // A fragment, not a group: background and fog attach to the parent
          // object, and a group would take them off the scene.
          <>
            <color attach="background" args={["#0a0812"]} />
            <fog attach="fog" args={["#0a0812", 30, 130]} />
            {/* Mostly directional, for the same reason as DechoWorld: ambient
                and hemisphere cannot tell one vertical face from another. */}
            <ambientLight intensity={0.2} />
            <hemisphereLight args={["#b98cff", "#1a1626", 0.45]} />
            <directionalLight position={[20, 40, 20]} intensity={1.6} />
            {/* Fill from a different azimuth, keeping the shadowed sides
                distinct from one another. */}
            <directionalLight position={[-25, 18, -12]} intensity={0.45} color="#8ea2ff" />
          </>
        )}

        <Player
          onShoot={handleShoot}
          onTriggerRelease={handleTriggerRelease}
          onLockChange={setLocked}
          spawnKey={levelKey}
          mode={mode}
          weapon={weapon}
          inputCaptured={chatOpen || menuOpen}
          continuous={weapon === "create" && (createMode === "flatten" || createMode === "restore")}
          halfSize={inWorld ? null : roomHalfSize}
          voxelWorld={voxelWorld}
        />

        {inWorld ? (
          // Never a half-loaded world: until the ground is in memory there is
          // nothing to draw, and the player stands on the flat floor that
          // voxelWorld falls back to for the moment it takes.
          worldReady ? (
            <DechoWorld craters={craters} pads={allPads} terrain={terrain} />
          ) : null
        ) : (
          <Arena halfSize={roomHalfSize} />
        )}
        {inGeoWorld && worldReady && surface != null && (
          <>
            {/* Cover first, roads on top of it — they run over the blocks, not
                under them, and each sits at its own height above the ground. */}
            <PatchLayer
              patches={surface.patches}
              cellSize={surface.patchCellSize}
              height={terrain.base}
            />
            <RoadLayer roads={surface.roads} height={terrain.base} />
            {/* Water after the roads: a bridge deck belongs over the river,
                and both are drawn against the same ground. */}
            <WaterLayer water={surface.water} height={terrain.base} />
            <BuildingLayer buildings={surface.buildings} height={terrain.base} />
          </>
        )}
        {targets.map((target) => (
          <TargetBlock
            key={target.id}
            target={target}
            hit={hitTargetId === target.id}
            labelRadius={targets.length > LABEL_BUDGET ? NEAR_LABEL_RADIUS : Infinity}
          />
        ))}
        <PresencePublisher onPose={handlePose} />
        <Avatars
          appearances={character.appearances}
          players={playersHere}
          tracksRef={tracksRef}
          playbackDelayRef={playbackDelayRef}
          speech={chat.speech}
        />
        <FurnitureLayer objects={objects} />
        <CubeLayer cubes={cubes} />
        <DoorLayer doors={doors} hitTargetId={hitTargetId} />
        <PaintLayer blobs={paint} />
        <StrokeLayer strokes={strokes} wet={wetStroke} />
        <TagLayer tags={tags} />
        <Impacts impacts={impacts} />
      </Canvas>

      {/* HUD */}
      <div className={css.hudTopLeft}>
        {current != null && <div className={css.levelKind}>{LEVEL_KIND_LABEL[current.kind]}</div>}
        <div className={css.levelTitle}>{title}</div>
        <div className={css.levelSubtitle}>{subtitle}</div>
        <div className={css.breadcrumb}>
          {["Hub", ...stack.map((crumb) => crumb.name)].join("  ›  ")}
        </div>
        {loading && <div className={css.status}>Loading targets…</div>}
        {entering && <div className={css.status}>Reading the elevation data…</div>}
        {enterError != null && <div className={css.error}>{enterError}</div>}
        {error != null && (
          <div className={css.error}>Could not load data: {(error as Error).message}</div>
        )}
        {empty && <div className={css.status}>Nothing here — press B to go back up.</div>}
      </div>

      <div className={css.hudTopRight}>
        {mode === "drag" ? (
          <>
            <span>W A S D move · Shift sprint · Ctrl sneak</span>
            <span>E or ← → turn · hold Q to zoom</span>
            <span>Drag with the left button to look</span>
            <span>Click fires · Space jumps · B goes back</span>
            <span>F tool options · C colours and tags</span>
            <span>Enter opens the item in the panel</span>
            <span>Number keys or scroll wheel pick a tool</span>
            <span>/ says something · M mutes chat</span>
            <span>H dresses your character</span>
          </>
        ) : (
          <>
            <span>W A S D move · Shift sprint · Ctrl sneak</span>
            <span>Mouse looks · left click fires · Space jumps</span>
            <span>Hold Q to zoom</span>
            <span>F tool options · C colours and tags</span>
            <span>B goes back · Enter opens the panel item</span>
            <span>Number keys or scroll wheel pick a tool</span>
            <span>/ says something · M mutes chat</span>
            <span>H dresses your character</span>
            <span>Click to take the cursor · menus give you one</span>
          </>
        )}
      </div>

      <div
        className={css.crosshair}
        style={{
          backgroundColor: crosshairColor,
          boxShadow: `0 0 6px ${crosshairColor}`,
        }}
      />

      {eraseProgress > 0 && (
        <div className={css.eraseTrack}>
          <div className={css.eraseFill} style={{ width: `${eraseProgress * 100}%` }} />
        </div>
      )}

      <div className={css.weaponBar}>
        <div className={css.weaponSlots}>
          {tools.map((entry, index) => {
            /*
             * What the tool is set to do, shown on every slot rather than only
             * the one in hand: the bar then answers "what will Draw do if I
             * press 2" without having to press it, and does not reflow as the
             * selection moves. Select and the eraser have no modes, so they
             * show nothing rather than an empty chip.
             */
            const mode =
              entry.id === "draw"
                ? drawMode === "tag"
                  ? "Tag"
                  : "Paint"
                : entry.id === "create"
                  ? createModeLabel
                  : null;

            /*
             * The colour the mode will use, where it uses one. Tag shows a
             * square instead of a dot — filled once an image is loaded, empty
             * until then — because what it pastes is a picture rather than a
             * colour.
             */
            const swatch: React.CSSProperties | null =
              entry.id === "draw"
                ? drawMode === "tag"
                  ? { borderRadius: 2, backgroundColor: tagImage == null ? "#3a3350" : "#ffd166" }
                  : { backgroundColor: sprayColor }
                : entry.id === "create" && createMode === "build"
                  ? { backgroundColor: withAlpha(cubeColor, cubeOpacity) }
                  : null;

            return (
              <div
                key={entry.id}
                // Against the tool, not the weapon: Draw's weapon is "paint" or
                // "tag" and Create's is "myspace" for a door, so comparing to the
                // weapon left those slots looking unselected.
                className={
                  entry.id === tool ? `${css.weaponSlot} ${css.weaponSlotActive}` : css.weaponSlot
                }
              >
                <span className={css.weaponKey}>{index + 1}</span>
                <span className={css.weaponName}>{entry.name}</span>
                {mode != null && <span className={css.weaponMode}>{mode}</span>}
                {swatch != null && <span className={css.swatch} style={swatch} />}
              </div>
            );
          })}
        </div>
        <div className={css.weaponHint}>{weaponHint}</div>
        <div className={css.syncLine}>
          <span
            className={css.syncDot}
            style={{
              backgroundColor:
                syncStatus === "live"
                  ? "#00ffb2"
                  : syncStatus === "loading"
                    ? "#ffd166"
                    : "#ff5c8a",
            }}
          />
          {syncStatus === "live"
            ? SHOW_DIAGNOSTICS
              ? `Synced · ${markCount} mark${markCount === 1 ? "" : "s"}`
              : "Synced"
            : syncStatus === "loading"
              ? "Loading painted history…"
              : "Offline · paint is local only"}
          {presenceEnabled && (
            <span>
              {SHOW_DIAGNOSTICS && ` · link ${presenceLink}`}
              {" · "}
              {playersHere.length === 0
                ? "alone in this room"
                : `${playersHere.length} other player${playersHere.length === 1 ? "" : "s"} here`}
              {SHOW_DIAGNOSTICS && ` · ${presenceStats.sent} poses sent`}
              {SHOW_DIAGNOSTICS &&
                presenceStats.gapMs > 0 &&
                ` · gap ${presenceStats.gapMs}ms · lag ${presenceStats.lagMs}ms · buffer ${presenceStats.delayMs}ms · publish ${presenceStats.publishMs}ms`}
            </span>
          )}
          {muted && <span> · chat muted</span>}
        </div>
        {SHOW_DIAGNOSTICS &&
          (syncError != null ||
            presenceStats.error != null ||
            chat.error != null ||
            character.error != null) && (
            <div className={css.syncError}>
              {syncError ?? presenceStats.error ?? chat.error ?? character.error}
            </div>
          )}
      </div>

      {/* Hidden picker used by the tag tool (press C). */}
      <input
        ref={fileInputRef}
        className={css.fileInput}
        type="file"
        accept="image/png,.png"
        onChange={handleFileChange}
      />

      {chatOpen && (
        <ChatComposer
          lockedUntil={chat.mine?.until ?? null}
          onSend={chat.send}
          onClose={() => setChatOpen(false)}
        />
      )}

      {/* Your message hangs over your head for everyone else. In first person
          this chip is the only place you can see it yourself. */}
      {chat.mine != null && (
        <div className={css.chatChip}>
          <span className={css.chatChipName}>You</span>
          <span className={css.chatChipText}>{chat.mine.text}</span>
        </div>
      )}

      {createPickerOpen && (
        <CreatePicker
          selected={createMode}
          allowTerrain={inWorld}
          models={models}
          onSelect={(mode) => {
            setCreateMode(mode);
            setCreatePickerOpen(false);
            setTool("create");
          }}
          onClose={() => setCreatePickerOpen(false)}
        />
      )}

      {pickerOpen && (
        <TagPicker
          entries={imageLibrary}
          onSelect={handlePickImage}
          onImportPath={handleImportPath}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {colorMenuOpen &&
        (tool === "draw" ? (
          <ColorWheel
            title="Paint colour"
            color={sprayColor}
            onChange={setSprayColor}
            onClose={() => setColorMenuOpen(false)}
          />
        ) : (
          <ColorWheel
            title="Cube colour"
            color={cubeColor}
            onChange={setCubeColor}
            opacity={cubeOpacity}
            onOpacityChange={setCubeOpacity}
            minOpacity={MIN_CUBE_OPACITY}
            onClose={() => setColorMenuOpen(false)}
          />
        ))}

      {drawPickerOpen && (
        <DrawPicker
          selected={drawMode}
          onSelect={(mode) => {
            setDrawMode(mode);
            setDrawPickerOpen(false);
            setTool("draw");
          }}
          onUpload={() => {
            setDrawPickerOpen(false);
            setDrawMode("tag");
            setTool("draw");
            // Needs to be a user gesture, and this click is one.
            fileInputRef.current?.click();
          }}
          onClose={() => setDrawPickerOpen(false)}
        />
      )}

      {characterOpen && (
        <CharacterPanel
          appearance={appearance}
          onChange={setDraftAppearance}
          onClose={closeCharacter}
        />
      )}

      <VirtualCursor active={menuOpen} />

      {toast != null && <div className={css.toast}>{toast}</div>}

      {stack.length > 0 && (
        <div className={css.navButtons}>
          <button className={css.backButton} onClick={goBack}>
            ◀ Back
          </button>
          <button className={css.backButton} onClick={goToHub}>
            ⌂ Hub
          </button>
        </div>
      )}

      {mode === "lock" && !locked && (
        <div className={css.lockPrompt}>
          <div className={css.lockCard}>
            <div className={css.lockTitle}>Foundry FPS</div>
            <div className={css.lockBody}>Click anywhere to lock the cursor and start moving.</div>
          </div>
        </div>
      )}

      {detail != null && (
        <div className={css.projectPanel}>
          <div className={css.projectType}>
            {detail.type === "app" ? "Foundry application" : humanizeType(detail.node.type)}
          </div>
          <div className={css.projectName}>
            {detail.type === "app" ? detail.app.name : detail.node.name}
          </div>
          <div className={css.projectPath}>
            {detail.type === "app" ? detail.app.url : detail.node.path}
          </div>
          <a className={css.projectLink} href={detailUrl ?? "#"} target="_blank" rel="noreferrer">
            Open in Foundry ↗
          </a>
          <div className={css.panelHint}>
            or press <kbd className={css.kbd}>Enter</kbd> to open it
          </div>
          <button className={css.panelClose} onClick={() => setDetail(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export default Game;
