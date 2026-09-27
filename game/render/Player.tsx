import React, { useCallback, useEffect, useRef } from "react";
import { PointerLockControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  EYE_HEIGHT,
  type Motion,
  type Obstacle,
  PLAYER_RADIUS,
  type VoxelWorld,
  floorUnder,
  supportedAt,
  sweepHorizontal,
  sweepVertical,
} from "@/game/world/collision";
import { ARENA_HALF_SIZE } from "@/game/world/level";
import { STEP_UP } from "@/game/world/voxels";

/**
 * What the trigger acts with.
 *
 * Derived by the game from the tool in hand and the mode it is in, rather
 * than chosen directly: Draw is "paint" or "tag", and Create is "myspace"
 * when a door is selected and "create" for everything else it makes.
 */
export type WeaponId = "select" | "paint" | "eraser" | "tag" | "myspace" | "create";

/** What a single trigger pull did. */
export type ShotAction =
  | "fire"
  | "spray"
  | "clean"
  | "tag"
  | "door"
  /** Place a prop, dig, or build — whichever the create tool is set to. */
  | "create";

export interface ShotResult {
  action: ShotAction;
  point: THREE.Vector3;
  /** Surface normal in world space, ready to orient a decal with. */
  normal: THREE.Vector3;
  /** Camera heading when the trigger was pulled, for orienting placed props. */
  cameraYaw: number;
  /** Set when a block (space / project / app) was hit, rather than a surface. */
  targetId?: string;
}

/**
 * "lock" uses the Pointer Lock API (best experience, needs a top level window).
 * "drag" is the fallback used inside sandboxed iframes where pointer lock is
 * blocked: hold the left mouse button to look around, click to fire.
 */
export type ControlMode = "lock" | "drag";

interface PlayerProps {
  onShoot: (shot: ShotResult) => void;
  /**
   * Fires once when a held trigger is let go, so a continuous tool knows where
   * its stroke ended. Inferring that from a gap between ticks would sometimes
   * split one press into two.
   */
  onTriggerRelease?: () => void;
  onLockChange?: (locked: boolean) => void;
  /** Changing this value teleports the player back to the spawn point. */
  spawnKey: string;
  mode: ControlMode;
  weapon: WeaponId;
  /**
   * True while a text field owns the keyboard (the chat composer). Movement,
   * jumping and the trigger are all ignored, and anything held down at the
   * moment capture begins is released — otherwise a key held as the composer
   * opens latches on and the player walks away while typing.
   */
  inputCaptured?: boolean;
  /**
   * Forces held-trigger behaviour for a tool that is not inherently
   * continuous — the create tool's flatten mode, which is swept around.
   */
  continuous?: boolean;
  /** Half-width of the current room, or null for an endless world. */
  halfSize?: number | null;
  /**
   * Voxels and terrain to collide against. Supplied by procedural rooms;
   * without it the floor is flat at y = 0 and only props are solid.
   */
  voxelWorld: VoxelWorld;
}

/**
 * Halved from 11: slower players mean less distance covered between presence
 * updates, so remote avatars jump half as far whatever the playback scheme.
 */
const MOVE_SPEED = 3.5;
const TURN_SPEED = 1.8;
const LOOK_SENSITIVITY = 0.0026;
const CLICK_SLOP_PX = 6;
/** Field of view while zoomed, as a fraction of the camera's normal fov. */
const ZOOM_FOV_FRACTION = 0.4;
/** Time constant of the zoom ease, in seconds. */
const ZOOM_TAU = 0.12;
const PITCH_LIMIT = Math.PI / 2 - 0.05;
/** Seconds between spray / mop ticks while the trigger is held. */
const CONTINUOUS_INTERVAL = 0.055;
/** Spraying and mopping only work at arm's length-ish distances. */
const SPRAY_RANGE = 14;

const ACTION_BY_WEAPON: Record<WeaponId, ShotAction> = {
  select: "fire",
  paint: "spray",
  eraser: "clean",
  tag: "tag",
  myspace: "door",
  create: "create",
};

/** Tools that keep firing while the trigger is held down. */
function isContinuous(weapon: WeaponId): boolean {
  return weapon === "paint" || weapon === "eraser";
}

/**
 * First person controller: mouse look, WASD movement and a hitscan trigger that
 * fires bullets, paint or mop strokes depending on the selected weapon.
 */
/** Upward speed of a jump, and the gravity that ends it. */
const JUMP_SPEED = 7.5;
const GRAVITY = 22;
/**
 * Clears a 1 m cube with room to spare: v²/2g ≈ 1.28 m. Snappier than real
 * gravity on purpose — a realistic arc feels floaty in a first-person game.
 */

/**
 * Pushes the player out of any prop they have walked into.
 *
 * Each prop is an oriented box, so the test happens in the box's own frame:
 * rotate the player into it, and if they are inside, slide them out along
 * whichever axis they are least deep on. That gives sliding contact rather
 * than sticking, which is what walls should feel like.
 */
function resolveCollisions(position: THREE.Vector3, obstacles: Obstacle[]): void {
  // The body occupies feet..eyes; an obstacle only counts if it overlaps that.
  const feet = position.y - EYE_HEIGHT;
  const head = position.y;

  for (const obstacle of obstacles) {
    if (obstacle.yMax != null && obstacle.yMin != null) {
      const clearsAbove = feet >= obstacle.yMax - 0.05;
      const clearsBelow = head <= obstacle.yMin + 0.05;
      // Low enough to step onto rather than walk into. Pushing the player out
      // of these is what stopped them getting up onto anything: the floor
      // lifts them over it instead.
      const steppable = obstacle.yMax <= feet + STEP_UP;
      if (clearsAbove || clearsBelow || steppable) {
        continue;
      }
    }

    const dx = position.x - obstacle.x;
    const dz = position.z - obstacle.z;
    const cos = Math.cos(obstacle.yaw);
    const sin = Math.sin(obstacle.yaw);

    const localX = dx * cos + dz * sin;
    const localZ = -dx * sin + dz * cos;
    const limitX = obstacle.halfX + PLAYER_RADIUS;
    const limitZ = obstacle.halfZ + PLAYER_RADIUS;

    if (Math.abs(localX) >= limitX || Math.abs(localZ) >= limitZ) {
      continue;
    }

    let pushedX = localX;
    let pushedZ = localZ;
    if (limitX - Math.abs(localX) < limitZ - Math.abs(localZ)) {
      pushedX = (localX < 0 ? -1 : 1) * limitX;
    } else {
      pushedZ = (localZ < 0 ? -1 : 1) * limitZ;
    }

    position.x = obstacle.x + (pushedX * cos - pushedZ * sin);
    position.z = obstacle.z + (pushedX * sin + pushedZ * cos);
  }
}

/**
 * Scratch objects for the trigger and the frame loop.
 *
 * There is one Player, and none of these escape the call that uses them, so
 * allocating them once keeps a few hundred throwaway vectors a second out of
 * the garbage collector's way.
 */
const SCREEN_CENTRE = new THREE.Vector2(0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const normalMatrix = new THREE.Matrix3();
const heading = new THREE.Euler(0, 0, 0, "YXZ");
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const wish = new THREE.Vector3();

function Player({
  onShoot,
  onTriggerRelease,
  onLockChange,
  spawnKey,
  mode,
  weapon,
  inputCaptured = false,
  continuous = false,
  halfSize = ARENA_HALF_SIZE,
  voxelWorld,
}: PlayerProps): React.ReactElement {
  const bound = halfSize == null ? null : halfSize - 1.5;
  const controlsRef = useRef<React.ElementRef<typeof PointerLockControls>>(null);
  const keys = useRef({
    forward: false,
    backward: false,
    left: false,
    right: false,
    turnLeft: false,
    turnRight: false,
    sprint: false,
    sneak: false,
    zoom: false,
  });
  /**
   * The camera's unzoomed field of view, captured on the first frame rather
   * than hardcoded, so this follows whatever Game sets on the Canvas.
   */
  const baseFov = useRef<number | null>(null);
  /** Current fov as a fraction of the base, used to slow down looking. */
  const zoomRatioRef = useRef(1);
  const { camera, scene, gl } = useThree();
  const raycaster = useRef(new THREE.Raycaster());
  const euler = useRef(new THREE.Euler(0, 0, 0, "YXZ"));
  const drag = useRef({ active: false, x: 0, y: 0, distance: 0 });
  const trigger = useRef({ held: false, cooldown: 0 });
  /** Vertical motion. `grounded` gates jumping so it cannot be repeated midair. */
  const jump = useRef({ requested: false, velocity: 0, grounded: true });
  const weaponRef = useRef(weapon);
  weaponRef.current = weapon;
  const capturedRef = useRef(inputCaptured);
  capturedRef.current = inputCaptured;
  /**
   * Where the player was standing in each room they have visited, so coming
   * back puts them where they left off rather than at the spawn point. Most
   * valuable in DechoWorld, where the walk back could be hundreds of metres.
   *
   * Session only: a reload starts everyone at the spawn point again.
   */
  const spawns = useRef(
    new Map<string, { x: number; y: number; z: number; yaw: number; pitch: number }>(),
  );
  const lastSpawnKey = useRef<string | null>(null);
  const continuousRef = useRef(continuous);
  continuousRef.current = continuous;

  /**
   * The tool's shot handler, behind a ref.
   *
   * Game rebuilds it whenever anything in the room changes — it reads the
   * paint, cubes and props to decide what a shot lands on — and depending on
   * it directly made pullTrigger unstable, which tore down and re-registered
   * the window mouse listeners below on every stream update.
   */
  const shootRef = useRef(onShoot);
  shootRef.current = onShoot;

  /** Hitscan from the middle of the screen using the active weapon. */
  const pullTrigger = useCallback(() => {
    const action = ACTION_BY_WEAPON[weaponRef.current];
    raycaster.current.setFromCamera(SCREEN_CENTRE, camera);
    const intersects = raycaster.current.intersectObjects(scene.children, true);
    const hit = intersects.find(
      (candidate) =>
        (candidate.object as THREE.Mesh).isMesh === true &&
        candidate.object.userData.shootable === true,
    );
    if (hit == null) {
      return;
    }
    if (action !== "fire" && hit.distance > SPRAY_RANGE) {
      return;
    }

    // Face normals are in object space, so convert to world space before the
    // caller uses them to offset or orient a decal. A fresh vector rather than
    // a scratch one: this is handed to the caller and outlives the shot.
    const normal = new THREE.Vector3(0, 1, 0);
    if (hit.face != null) {
      normal
        .copy(hit.face.normal)
        .applyMatrix3(normalMatrix.getNormalMatrix(hit.object.matrixWorld))
        .normalize();
    }

    heading.setFromQuaternion(camera.quaternion);

    shootRef.current({
      action,
      point: hit.point.clone(),
      normal,
      cameraYaw: heading.y,
      targetId: hit.object.userData.targetId as string | undefined,
    });
  }, [camera, scene]);

  const releaseRef = useRef(onTriggerRelease);
  releaseRef.current = onTriggerRelease;

  /**
   * Drops the trigger, and tells the tool about it exactly once — only if it
   * really had been held, so the many places that defensively clear the
   * trigger cannot each end a stroke that was never started.
   */
  const releaseTrigger = useCallback(() => {
    if (!trigger.current.held) {
      return;
    }
    trigger.current.held = false;
    releaseRef.current?.();
  }, []);

  /**
   * On a room change, remember where the player was standing in the room they
   * are leaving, and put them back where they left off if they have been in
   * the new one before. First visits still start at the spawn point.
   *
   * Saving and restoring are one effect, in Player rather than in Game,
   * because this is the only place that owns the camera. A parent could not
   * do the saving half: child effects run first, so the camera would already
   * have been moved before the parent got a chance to read it.
   */
  useEffect(() => {
    const leaving = lastSpawnKey.current;
    if (leaving != null && leaving !== spawnKey) {
      const heading = new THREE.Euler(0, 0, 0, "YXZ").setFromQuaternion(camera.quaternion);
      spawns.current.set(leaving, {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        yaw: heading.y,
        pitch: heading.x,
      });
    }
    lastSpawnKey.current = spawnKey;

    const remembered = spawns.current.get(spawnKey);
    if (remembered != null) {
      camera.position.set(remembered.x, remembered.y, remembered.z);
      // Drag mode steers from this euler rather than from the camera, so it
      // has to be brought along too or the first drag snaps the view back.
      euler.current.set(remembered.pitch, remembered.yaw, 0, "YXZ");
      camera.quaternion.setFromEuler(euler.current);
    } else {
      camera.position.set(0, EYE_HEIGHT, 0);
    }

    // Landing is left to the frame loop. If the ground moved while the player
    // was away — someone dug or levelled underneath them — the vertical sweep
    // snaps them onto whatever the floor is now, rather than trusting a
    // remembered height that may no longer have anything under it.
    jump.current = { requested: false, velocity: 0, grounded: true };
  }, [camera, spawnKey]);

  // Movement keys (both control modes) and keyboard firing.
  useEffect(() => {
    const setKey = (code: string, pressed: boolean): void => {
      if (code === "KeyW" || code === "ArrowUp") {
        keys.current.forward = pressed;
      }
      if (code === "KeyS" || code === "ArrowDown") {
        keys.current.backward = pressed;
      }
      if (code === "KeyA") {
        keys.current.left = pressed;
      }
      if (code === "KeyD") {
        keys.current.right = pressed;
      }
      // Q zooms rather than turning. Drag mode still turns with E and the
      // arrow keys, which the HUD already offers as the alternative.
      if (code === "KeyQ") {
        keys.current.zoom = pressed;
      }
      if (code === "ArrowLeft") {
        keys.current.turnLeft = pressed;
      }
      if (code === "KeyE" || code === "ArrowRight") {
        keys.current.turnRight = pressed;
      }
      if (code === "ShiftLeft" || code === "ShiftRight") {
        keys.current.sprint = pressed;
      }
      if (code === "ControlLeft" || code === "ControlRight") {
        keys.current.sneak = pressed;
      }
    };

    const handleKeyDown = (e: KeyboardEvent): void => {
      // Typing in the chat composer must not also drive the player.
      if (capturedRef.current) {
        return;
      }
      setKey(e.code, true);
      if (e.code === "Space") {
        // Stop the page scrolling, and remember the press: the jump itself is
        // applied in the frame loop, where we know whether we are grounded.
        e.preventDefault();
        jump.current.requested = true;
      }
    };
    // Key releases are never ignored, even while captured: dropping one would
    // leave that direction latched on once the composer closes.
    const handleKeyUp = (e: KeyboardEvent): void => {
      setKey(e.code, false);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // Let go of everything the instant a text field takes the keyboard. Without
  // this, a key held down as the composer opens is never seen being released
  // and the player keeps moving for as long as they are typing.
  useEffect(() => {
    if (!inputCaptured) {
      return;
    }
    keys.current = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      turnLeft: false,
      turnRight: false,
      sprint: false,
      sneak: false,
      zoom: false,
    };
    releaseTrigger();
    jump.current.requested = false;
  }, [inputCaptured, releaseTrigger]);

  // Release the trigger if the mouse comes up outside the canvas.
  useEffect(() => {
    const release = (): void => releaseTrigger();
    window.addEventListener("blur", release);
    return () => window.removeEventListener("blur", release);
  }, [releaseTrigger]);

  // Pointer lock mode: hold the left button to keep the trigger down.
  useEffect(() => {
    if (mode !== "lock") {
      return;
    }

    const handleMouseDown = (e: MouseEvent): void => {
      // No firing, and no grabbing the cursor back, while a menu or the chat
      // composer owns the input.
      if (e.button !== 0 || capturedRef.current) {
        return;
      }
      // Unlocked means a menu just gave the cursor up, or the page has only
      // just loaded. The click takes it back rather than firing, so the shot
      // that re-enters the world is never spent on something unintended.
      if (controlsRef.current?.isLocked !== true) {
        controlsRef.current?.lock();
        return;
      }
      trigger.current.held = true;
      pullTrigger();
    };
    const handleMouseUp = (e: MouseEvent): void => {
      if (e.button === 0) {
        releaseTrigger();
      }
    };

    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [mode, pullTrigger, releaseTrigger]);

  /**
   * Stop the camera turning while something else owns the input, without
   * giving up the lock.
   *
   * Set on the controls object directly rather than through drei's `enabled`
   * prop: three's PointerLockControls checks this in its own mousemove
   * handler, so the lock survives and only the looking stops. That is what
   * lets a menu use the mouse while the pointer stays captured.
   */
  useEffect(() => {
    const controls = controlsRef.current as unknown as { enabled?: boolean } | null;
    if (controls != null) {
      controls.enabled = !inputCaptured;
    }
  }, [inputCaptured]);

  // Drag mode: hold the left button to look, click (without dragging) to fire.
  // Spray and mop keep working while dragging, which doubles as aiming.
  useEffect(() => {
    if (mode !== "drag") {
      return;
    }

    const element = gl.domElement;
    euler.current.setFromQuaternion(camera.quaternion);
    onLockChange?.(true);

    const handlePointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 || capturedRef.current) {
        return;
      }
      drag.current = { active: true, x: e.clientX, y: e.clientY, distance: 0 };
      element.setPointerCapture(e.pointerId);
      if (isContinuous(weaponRef.current) || continuousRef.current) {
        trigger.current.held = true;
        pullTrigger();
      }
    };

    const handlePointerMove = (e: PointerEvent): void => {
      if (!drag.current.active) {
        return;
      }
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      drag.current.x = e.clientX;
      drag.current.y = e.clientY;
      drag.current.distance += Math.abs(dx) + Math.abs(dy);

      // Scaled by the zoom, for the same reason pointer lock is: a narrow
      // field of view turns a small drag into a large sweep.
      const sensitivity = LOOK_SENSITIVITY * zoomRatioRef.current;
      euler.current.y -= dx * sensitivity;
      euler.current.x = THREE.MathUtils.clamp(
        euler.current.x - dy * sensitivity,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      );
      camera.quaternion.setFromEuler(euler.current);
    };

    const handlePointerUp = (e: PointerEvent): void => {
      if (!drag.current.active) {
        return;
      }
      drag.current.active = false;
      releaseTrigger();
      if (element.hasPointerCapture(e.pointerId)) {
        element.releasePointerCapture(e.pointerId);
      }
      if (!isContinuous(weaponRef.current) && drag.current.distance < CLICK_SLOP_PX) {
        pullTrigger();
      }
    };

    element.addEventListener("pointerdown", handlePointerDown);
    element.addEventListener("pointermove", handlePointerMove);
    element.addEventListener("pointerup", handlePointerUp);
    return () => {
      element.removeEventListener("pointerdown", handlePointerDown);
      element.removeEventListener("pointermove", handlePointerMove);
      element.removeEventListener("pointerup", handlePointerUp);
    };
  }, [mode, gl, camera, pullTrigger, releaseTrigger, onLockChange]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    const active = mode === "drag" || controls?.isLocked === true;
    if (!active) {
      return;
    }

    // Zoom: ease the field of view towards its target while Q is held.
    if (camera instanceof THREE.PerspectiveCamera) {
      if (baseFov.current == null) {
        baseFov.current = camera.fov;
      }
      const base = baseFov.current;
      const target = keys.current.zoom ? base * ZOOM_FOV_FRACTION : base;
      const eased = camera.fov + (target - camera.fov) * (1 - Math.exp(-delta / ZOOM_TAU));
      // Snap the last fraction of a degree, so a settled camera stops
      // rebuilding its projection matrix every frame forever.
      const next = Math.abs(target - eased) < 0.05 ? target : eased;

      if (next !== camera.fov) {
        camera.fov = next;
        camera.updateProjectionMatrix();
      }

      // Looking has to slow down with the narrowed view, or aiming while
      // zoomed is unusably twitchy: the same mouse movement sweeps across far
      // more of the world when the field of view is small.
      const ratio = camera.fov / base;
      zoomRatioRef.current = ratio;
      if (controls != null) {
        // pointerSpeed is a property of three's PointerLockControls but is not
        // in drei's prop types. Assigning it is harmless where unsupported.
        (controls as unknown as { pointerSpeed?: number }).pointerSpeed = ratio;
      }
    }

    // Continuous paint / mop while the trigger stays down.
    if ((isContinuous(weapon) || continuous) && trigger.current.held) {
      trigger.current.cooldown -= delta;
      if (trigger.current.cooldown <= 0) {
        trigger.current.cooldown = CONTINUOUS_INTERVAL;
        pullTrigger();
      }
    } else {
      trigger.current.cooldown = 0;
    }

    // Sneak beats sprint when both are held: if you are asking to be careful
    // and to hurry at once, careful wins.
    const pace = keys.current.sneak ? 0.5 : keys.current.sprint ? 1.8 : 1;
    const speed = MOVE_SPEED * pace * delta;

    if (mode === "drag") {
      // Keyboard turning, needed because looking requires a mouse drag here.
      const turn = TURN_SPEED * delta;
      if (keys.current.turnLeft) {
        euler.current.y += turn;
      }
      if (keys.current.turnRight) {
        euler.current.y -= turn;
      }
      if (keys.current.turnLeft || keys.current.turnRight) {
        camera.quaternion.setFromEuler(euler.current);
      }
    }

    // Intended movement for this frame, in world units. Both control modes
    // walk along the camera basis; collecting the intent first is what lets it
    // be swept against the world rather than applied blind.
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.crossVectors(forward, UP).normalize();

    wish.set(0, 0, 0);
    if (keys.current.forward) {
      wish.addScaledVector(forward, speed);
    }
    if (keys.current.backward) {
      wish.addScaledVector(forward, -speed);
    }
    if (keys.current.right) {
      wish.addScaledVector(right, speed);
    }
    if (keys.current.left) {
      wish.addScaledVector(right, -speed);
    }

    // Jump intent is consumed here, where being grounded is known.
    if (jump.current.requested && jump.current.grounded) {
      jump.current.velocity = JUMP_SPEED;
      jump.current.grounded = false;
    }
    jump.current.requested = false;

    /*
     * One collision path for every room. Flat rooms are handed a world whose
     * terrain is a constant zero, so substepped sweeping, step-up, sneak edge
     * protection and landing all behave identically everywhere.
     *
     * They used to have a second, simpler implementation of the same ideas,
     * which is where the hovering-off-a-prop and snapping-onto-a-table bugs
     * came from: sweepVertical had always handled both cases correctly and
     * the copy had to re-earn them.
     */
    const start: Motion = {
      x: camera.position.x,
      z: camera.position.z,
      feetY: camera.position.y - EYE_HEIGHT,
    };

    let swept: Motion;
    if (keys.current.sneak && jump.current.grounded) {
      // Sneaking on the ground refuses any step that would leave the player
      // unsupported. The two axes are tested separately so you can still
      // slide along the lip of a drop rather than sticking to it the moment
      // one direction is refused.
      //
      // Only while grounded: in mid-air there is nothing to be pushed off,
      // and testing there would let a player hang in space by holding Ctrl.
      swept = start;
      const alongX = sweepHorizontal(voxelWorld, swept, wish.x, 0);
      if (supportedAt(voxelWorld, alongX.x, alongX.feetY, alongX.z)) {
        swept = alongX;
      }
      const alongZ = sweepHorizontal(voxelWorld, swept, 0, wish.z);
      if (supportedAt(voxelWorld, alongZ.x, alongZ.feetY, alongZ.z)) {
        swept = alongZ;
      }
    } else {
      swept = sweepHorizontal(voxelWorld, start, wish.x, wish.z);
    }

    if (!jump.current.grounded) {
      jump.current.velocity -= GRAVITY * delta;
    }
    const vertical = sweepVertical(
      voxelWorld,
      swept,
      {
        feetY: swept.feetY,
        velocity: jump.current.velocity,
        grounded: jump.current.grounded,
      },
      delta,
    );
    jump.current.velocity = vertical.velocity;
    jump.current.grounded = vertical.grounded;

    camera.position.set(swept.x, vertical.feetY + EYE_HEIGHT, swept.z);

    // Standing still on ground that has been dug away, or on a prop that has
    // been walked off the edge of, should start a fall.
    if (
      jump.current.grounded &&
      vertical.feetY > floorUnder(voxelWorld, swept.x, vertical.feetY, swept.z) + 0.05
    ) {
      jump.current.grounded = false;
    }

    /*
     * Props are solid: walk into one and you slide along it.
     *
     * Props only. Cubes used to be pushed out here as well, which meant every
     * frame tested the player against every cube in the room — over a
     * thousand of them in DechoWorld — immediately after the swept collision
     * above had already resolved them out of the voxel map. Worse than the
     * cost, the two disagreed: the sweep deliberately lets you step onto a low
     * cube, and this pass would then shove you back off it.
     *
     * This remains for props because it is the only thing that recovers a
     * player who is already inside one — something dropped on top of them, or
     * a prop that grew when its model finished loading.
     */
    resolveCollisions(camera.position, voxelWorld.props ?? []);

    // Keep the player inside the room, where the room has edges at all.
    if (bound != null) {
      camera.position.x = THREE.MathUtils.clamp(camera.position.x, -bound, bound);
      camera.position.z = THREE.MathUtils.clamp(camera.position.z, -bound, bound);
    }
  });

  if (mode === "drag") {
    return <group />;
  }

  return (
    <PointerLockControls
      ref={controlsRef}
      /*
       * Deliberately a selector that matches nothing. drei otherwise attaches
       * its own click-to-lock handler, which would race the mousedown handler
       * above — the one that decides whether a click takes the cursor back or
       * fires the tool in hand. With this, that decision is made in exactly
       * one place.
       */
      selector="#fps-lock-is-explicit"
      onLock={() => onLockChange?.(true)}
      onUnlock={() => onLockChange?.(false)}
    />
  );
}

export default Player;
