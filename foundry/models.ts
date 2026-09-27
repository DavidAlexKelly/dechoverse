import * as THREE from "three";
import { displayNameOf, foldersOf, listGlbPaths, loadGlbScene } from "@/foundry/glb";
import { cachedPromise } from "@/shared/promiseCache";

/**
 * [AP] Objects — the GLB model pack, laid out as furniture/<category>/<name>.glb.
 *
 * Models are discovered by listing the dataset rather than hardcoded, so
 * dropping another GLB into the right folder puts it in the picker with no
 * code change at all.
 */
export const OBJECTS_DATASET_RID = "ri.foundry.main.dataset.3f85469e-47b8-4ba7-9cae-5a62e3427040";
export const OBJECTS_BRANCH = "master";

/** Largest a placed prop may be, in metres, along its biggest axis. */
const MAX_PROP_SIZE = 4;
/** Smallest, so a mis-scaled model is not invisible. */
const MIN_PROP_SIZE = 0.05;
/** What an out-of-range model is resized to. */
const TARGET_PROP_SIZE = 1.5;
/**
 * Everything from the pack is placed this much larger than its natural size.
 *
 * Applied after the sanity band above, so a model that needed normalising and
 * one that did not both come out the same amount bigger. The band is there to
 * catch models exported in the wrong units, not to cap the final size, so it
 * is deliberately not re-checked afterwards.
 */
const MODEL_SCALE = 1.15;
/** Footprint used for a prop whose model has not finished loading. */
export const DEFAULT_FOOTPRINT = { halfX: 0.4, halfZ: 0.4, height: 1 };

export interface ObjectModel {
  /** Path within the dataset, and the id stored on the mark. */
  path: string;
  /** Top-level folder, e.g. "furniture" — the picker's tab. */
  group: string;
  /** Second-level folder, e.g. "living room" — the picker's sub-tab. */
  category: string;
  /** Human-readable name from the file name. */
  name: string;
}

export interface ModelFootprint {
  halfX: number;
  halfZ: number;
  height: number;
}

interface LoadedModel {
  scene: THREE.Object3D;
  footprint: ModelFootprint;
}

const modelCache = new Map<string, Promise<LoadedModel>>();
const footprints = new Map<string, ModelFootprint>();

/**
 * Footprints only become known once a model's geometry has loaded, and
 * collision is computed outside React from a plain memo. This lets anything
 * that depends on them re-derive when a load completes.
 */
let loadVersion = 0;
const listeners = new Set<() => void>();

export function subscribeModelLoads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function modelLoadVersion(): number {
  return loadVersion;
}

/** The measured footprint of a model, or a default until it has loaded. */
export function footprintOf(path: string): ModelFootprint {
  return footprints.get(path) ?? DEFAULT_FOOTPRINT;
}

/**
 * Every model in the pack.
 *
 * Listed from the dataset rather than kept in a constant, so the catalogue is
 * whatever is actually in the folder. Returns an empty list on any failure —
 * the tool still works, it just offers the two built-in props.
 *
 * The first folder is the picker's tab and the second its sub-tab, so
 * furniture/living room/Chair_17.glb lands under Furniture > Living room.
 */
export async function listObjectModels(): Promise<ObjectModel[]> {
  const models: ObjectModel[] = [];

  for (const path of await listGlbPaths(OBJECTS_DATASET_RID, OBJECTS_BRANCH)) {
    const folders = foldersOf(path);
    models.push({
      path,
      group: folders.group,
      category: folders.category,
      name: displayNameOf(path),
    });
  }

  return models.sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Measures a model and returns the transform that makes it sit sensibly.
 *
 * Model packs are exported at wildly inconsistent scales — some in
 * centimetres, some in metres, some at whatever the artist was working in. A
 * model whose largest axis lands outside a sane band is resized; anything
 * already reasonable is left at its natural size, because scaling everything
 * to a common height would make a toothbrush as tall as a wardrobe.
 *
 * The model is also recentred horizontally and dropped so its base sits at
 * y = 0, since an origin at the centre of the mesh would half-bury it.
 */
function fit(scene: THREE.Object3D): { scale: number; offset: THREE.Vector3 } {
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z);

  const natural =
    largest > MAX_PROP_SIZE || largest < MIN_PROP_SIZE
      ? TARGET_PROP_SIZE / Math.max(largest, 1e-6)
      : 1;
  const scale = natural * MODEL_SCALE;

  return {
    scale,
    offset: new THREE.Vector3(-centre.x * scale, -box.min.y * scale, -centre.z * scale),
  };
}

/**
 * Downloads and parses a model, once per session.
 *
 * The blob URL is revoked as soon as the loader is done with it: GLB is
 * self-contained, so nothing is fetched from it afterwards.
 */
export async function loadObjectModel(path: string): Promise<LoadedModel> {
  return cachedPromise(modelCache, path, async () => {
    const scene = await loadGlbScene(OBJECTS_DATASET_RID, OBJECTS_BRANCH, path);
    const { scale, offset } = fit(scene);
    scene.scale.setScalar(scale);
    scene.position.copy(offset);

    // Props are hit-tested per mesh: userData is not inherited from a
    // parent, and the eraser finds things by the meshes they are made of.
    scene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.userData = { shootable: true };
      }
    });

    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const footprint: ModelFootprint = {
      halfX: Math.max(size.x / 2, 0.05),
      halfZ: Math.max(size.z / 2, 0.05),
      height: Math.max(size.y, 0.05),
    };

    footprints.set(path, footprint);
    loadVersion += 1;
    for (const listener of listeners) {
      listener();
    }

    return { scene, footprint };
  });
}
