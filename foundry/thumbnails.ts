import * as THREE from "three";
import { loadObjectModel } from "@/foundry/models";
import { loadHat } from "@/foundry/wearables";
import { cachedPromise } from "@/shared/promiseCache";

/**
 * Preview images for the model picker, rendered from the models themselves.
 *
 * Deliberately not stored as uploaded images. A folder of thumbnails has to
 * be produced by hand, kept named in step with the models, and goes stale the
 * moment someone adds a GLB — whereas rendering from the model is always
 * correct and needs nothing kept in sync.
 *
 * One renderer is shared by every thumbnail. A canvas each would be the
 * obvious approach and is unusable here: browsers cap live WebGL contexts at
 * somewhere around eight to sixteen, and the pack has dozens of models. So
 * this draws each model in turn on a single offscreen renderer and keeps the
 * result as a data URL.
 */

const SIZE = 128;
/** Roughly three-quarter view, which reads better than dead-on for furniture. */
const VIEW_DIRECTION = new THREE.Vector3(1, 0.65, 1).normalize();
const FIELD_OF_VIEW = 35;
/** A little air around the model so it does not touch the edges. */
const FRAMING_MARGIN = 1.15;

const cache = new Map<string, Promise<string>>();

let renderer: THREE.WebGLRenderer | null = null;

function sharedRenderer(): THREE.WebGLRenderer {
  if (renderer == null) {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      // toDataURL reads the drawing buffer, which is cleared after a render
      // unless it is preserved.
      preserveDrawingBuffer: true,
    });
    renderer.setSize(SIZE, SIZE);
    renderer.setClearColor(0x000000, 0);
  }
  return renderer;
}

/** Lighting for the preview, matching the game's key-plus-fill arrangement. */
function buildScene(model: THREE.Object3D): THREE.Scene {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));

  const key = new THREE.DirectionalLight(0xfff6e0, 2);
  key.position.set(3, 5, 4);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9fc4e8, 0.7);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  scene.add(model);
  return scene;
}

/** Pulls the camera back far enough to hold the whole model in frame. */
function frame(model: THREE.Object3D): THREE.PerspectiveCamera {
  const sphere = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());

  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.01, 1000);
  const distance = (sphere.radius / Math.sin((FIELD_OF_VIEW * Math.PI) / 360)) * FRAMING_MARGIN;

  camera.position.copy(sphere.center).addScaledVector(VIEW_DIRECTION, distance);
  camera.lookAt(sphere.center);
  return camera;
}

/**
 * A PNG data URL of the model, rendered once and kept for the session.
 *
 * Rendering needs the model, so opening a tab downloads the models in it.
 * That is not wasted work: the same cache serves placing them, so the first
 * prop you drop from a tab you have looked at appears instantly.
 */
async function renderThumbnail(key: string, load: () => Promise<THREE.Object3D>): Promise<string> {
  return cachedPromise(cache, key, async () => {
    const original = await load();
    // Cloned so the preview cannot disturb the copy the world is using, and
    // detached afterwards so the clone can be collected.
    const model = original.clone(true);
    const scene = buildScene(model);
    const camera = frame(model);

    const gl = sharedRenderer();
    gl.render(scene, camera);
    const url = gl.domElement.toDataURL("image/png");

    scene.remove(model);
    return url;
  });
}

/** A preview of a prop from the model pack. */
export async function objectThumbnail(path: string): Promise<string> {
  return renderThumbnail(`object:${path}`, async () => (await loadObjectModel(path)).scene);
}

/**
 * A preview of a hat.
 *
 * Keyed separately from props even though the paths could not collide, so that
 * the cache says what it holds. Rendering a hat also warms the model cache
 * that Hat.tsx reads, so the first one you pick appears on your head at once.
 */
export async function hatThumbnail(path: string): Promise<string> {
  return renderThumbnail(`hat:${path}`, () => loadHat(path));
}
