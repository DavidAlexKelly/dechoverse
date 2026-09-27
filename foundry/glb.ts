import { Datasets } from "@osdk/foundry";
import type * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import client from "@/foundry/client";
import { cachedPromise } from "@/shared/promiseCache";

/**
 * Reading GLB models out of a Foundry dataset.
 *
 * Two packs use this — the props in [AP] Objects and the hats in
 * [AP] Wearables — and they want the same three things from a dataset (what is
 * in it, the bytes of one file, a readable name from a path) but very
 * different things afterwards: a prop is normalised to a sane size and made
 * shootable, a hat is fitted to a head. So the download and parse live here
 * and the fitting policy lives with each pack.
 */

const sceneCache = new Map<string, Promise<THREE.Object3D>>();

/** Every GLB in a dataset, sorted by path. */
export async function listGlbPaths(datasetRid: string, branchName: string): Promise<string[]> {
  const paths: string[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const page = await Datasets.Files.list(client, datasetRid, {
      branchName,
      pageSize: 500,
      pageToken,
    });
    for (const file of page.data) {
      if (file.path.toLowerCase().endsWith(".glb")) {
        paths.push(file.path);
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken != null);

  return paths.sort((a, b) => a.localeCompare(b));
}

/**
 * Downloads and parses one model, once per dataset and path.
 *
 * The blob URL is revoked as soon as the loader is done with it: GLB is
 * self-contained, so nothing is fetched from it afterwards.
 *
 * The scene handed back is the cached original, not a copy — callers fit it to
 * their own purposes and clone it per use, which is safe only because one path
 * has one consumer. Do not read the same file from two packs with different
 * fitting policies.
 */
export async function loadGlbScene(
  datasetRid: string,
  branchName: string,
  path: string,
): Promise<THREE.Object3D> {
  return cachedPromise(sceneCache, `${datasetRid}|${path}`, async () => {
    const response = await Datasets.Files.content(client, datasetRid, path, { branchName });
    const url = URL.createObjectURL(await response.blob());
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      return gltf.scene;
    } finally {
      URL.revokeObjectURL(url);
    }
  });
}

/** "furniture/living room/Coffee_Table_03.glb" -> "Coffee Table 03". */
export function displayNameOf(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file
    .replace(/\.glb$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

/**
 * The folders a model sits in: the first two path segments, with the file
 * itself dropped.
 *
 * Both packs are laid out the same way — furniture/living room/Chair_17.glb,
 * wearables/hats/TopHat.glb — so the folders are what the pickers group on. A
 * model with no second folder gets an empty category.
 */
export function foldersOf(path: string): { group: string; category: string } {
  const parts = path.split("/").filter((part) => part !== "");
  const folders = parts.slice(0, -1);
  return {
    group: folders.length > 0 ? folders[0] : "other",
    category: folders.length > 1 ? folders[1] : "",
  };
}
