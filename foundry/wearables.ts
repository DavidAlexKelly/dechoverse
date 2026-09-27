import * as THREE from "three";
import { displayNameOf, foldersOf, listGlbPaths, loadGlbScene } from "@/foundry/glb";
import { cachedPromise } from "@/shared/promiseCache";

/**
 * [AP] Wearables — things a character can wear.
 *
 * Everything in the pack is a hat today, and the files sit directly in
 * wearables/, so a file that names no slot is taken to be one. A file in a
 * folder — wearables/glasses/Shades.glb — declares its slot instead, which is
 * how a second slot can be added later without moving the hats.
 */
export const WEARABLES_DATASET_RID = "ri.foundry.main.dataset.1fa1a761-9573-43c8-a910-d378c10f10c5";
export const WEARABLES_BRANCH = "master";

/** The slot hats occupy, and the one assumed of a file that names none. */
const HAT_SLOT = "hats";

/**
 * Which slot a wearable belongs in.
 *
 * `wearables/TopHat.glb` names no slot and is a hat; `wearables/hats/TopHat.glb`
 * says so; `wearables/glasses/Shades.glb` is something else and is left alone.
 */
function slotOf(path: string): string {
  const { category } = foldersOf(path);
  return category === "" ? HAT_SLOT : category;
}

/**
 * How wide a hat is made, in metres, across its widest horizontal axis.
 *
 * An avatar's head is the top of a capsule of radius 0.34, so 0.68 across. A
 * fraction wider than that reads as sitting *on* the head rather than being
 * balanced on it, and stops a brim disappearing into the skull.
 */
const HAT_WIDTH = 0.74;
/**
 * Tallest a hat may be once scaled.
 *
 * Hats are fitted by width, because that is what has to match a head — but a
 * model exported in the wrong units, or a genuinely absurd one, would then be
 * storeys tall. Capping the height re-fits by height instead, which keeps the
 * proportions and merely makes the thing smaller.
 */
const HAT_MAX_HEIGHT = 0.75;

export interface Wearable {
  /** Path within the dataset. This is what a character record stores. */
  path: string;
  name: string;
}

const hatCache = new Map<string, Promise<THREE.Object3D>>();

/**
 * Every hat in the pack.
 *
 * Throws if the dataset cannot be read, rather than resolving empty: an empty
 * wardrobe and an unreadable one look identical on screen otherwise, and one
 * of them is a permissions problem worth being told about.
 */
export async function listHats(): Promise<Wearable[]> {
  const paths = await listGlbPaths(WEARABLES_DATASET_RID, WEARABLES_BRANCH);
  return paths
    .filter((path) => slotOf(path) === HAT_SLOT)
    .map((path) => ({ path, name: displayNameOf(path) }));
}

/**
 * Sizes a hat to a head and drops it so its base sits at y = 0.
 *
 * Everything is measured from the model's own geometry rather than kept in a
 * table of per-hat offsets: the pack is a folder anyone can add to, and a
 * table would be a second thing to keep in step with it. The anchor group in
 * Hat.tsx then only has to know where the top of a head is.
 */
function fitToHead(scene: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());

  const widest = Math.max(size.x, size.z, 1e-6);
  let scale = HAT_WIDTH / widest;
  if (size.y * scale > HAT_MAX_HEIGHT) {
    scale = HAT_MAX_HEIGHT / Math.max(size.y, 1e-6);
  }

  scene.scale.setScalar(scale);
  // Centred over the head, and resting on it rather than half sunk into it.
  scene.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
}

/**
 * Downloads a hat and fits it to a head, once per session.
 *
 * The scene returned is shared, so callers clone it — an Object3D can only sit
 * at one place in the graph, and several players may wear the same hat.
 */
export async function loadHat(path: string): Promise<THREE.Object3D> {
  return cachedPromise(hatCache, path, async () => {
    const scene = await loadGlbScene(WEARABLES_DATASET_RID, WEARABLES_BRANCH, path);
    fitToHead(scene);
    return scene;
  });
}
