import { MediaSets } from "@osdk/foundry.mediasets";
import * as THREE from "three";
import client from "@/foundry/client";
import { cachedPromise } from "@/shared/promiseCache";

/** [AP] tags — every image pasted with the tag tool lives here. */
export const TAG_MEDIA_SET_RID = "ri.mio.main.media-set.97b17e9e-412b-4169-9fa8-a8907a92e879";

/** Only PNGs are accepted, so every tag decodes with a predictable alpha. */
export const TAG_IMAGE_MIME = "image/png";

/** Blob URLs, textures and display names are fetched once per media item. */
const urlCache = new Map<string, Promise<string>>();
const textureCache = new Map<string, Promise<{ texture: THREE.Texture; aspect: number }>>();
const nameCache = new Map<string, Promise<string>>();

export function isPng(file: File): boolean {
  return file.type === TAG_IMAGE_MIME || file.name.toLowerCase().endsWith(".png");
}

/**
 * Uploads an image and returns its media item RID. Transactional media sets
 * reject a bare upload, so fall back to create → upload → commit.
 */
export async function uploadTagImage(file: File): Promise<string> {
  const path = `${Date.now()}-${file.name}`;

  try {
    const response = await MediaSets.upload(client, TAG_MEDIA_SET_RID, file, {
      mediaItemPath: path,
      preview: true,
    });
    return response.mediaItemRid;
  } catch {
    const transactionId = await MediaSets.create(client, TAG_MEDIA_SET_RID, {
      preview: true,
    });
    try {
      const response = await MediaSets.upload(client, TAG_MEDIA_SET_RID, file, {
        mediaItemPath: path,
        transactionId,
        preview: true,
      });
      await MediaSets.commit(client, TAG_MEDIA_SET_RID, transactionId, {
        preview: true,
      });
      return response.mediaItemRid;
    } catch (error) {
      await MediaSets.abort(client, TAG_MEDIA_SET_RID, transactionId, {
        preview: true,
      }).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Resolves a media item that already exists in the media set by its path.
 *
 * The media sets API has no "list items" endpoint, so images uploaded outside
 * this app can only be found if you know the file name they were stored under.
 */
export async function findMediaItemByPath(mediaItemPath: string): Promise<string | null> {
  const response = await MediaSets.getRidByPath(client, TAG_MEDIA_SET_RID, {
    mediaItemPath,
    preview: true,
  });
  return response.mediaItemRid ?? null;
}

/** Downloads a media item once and keeps the blob URL for the session. */
export async function getTagImageUrl(mediaItemRid: string): Promise<string> {
  return cachedPromise(urlCache, mediaItemRid, async () => {
    const response = await MediaSets.read(client, TAG_MEDIA_SET_RID, mediaItemRid);
    return URL.createObjectURL(await response.blob());
  });
}

/** Turns a media item into a texture the scene can render, cached per RID. */
export async function loadTagTexture(
  mediaItemRid: string,
): Promise<{ texture: THREE.Texture; aspect: number }> {
  return cachedPromise(textureCache, mediaItemRid, async () =>
    textureFromUrl(await getTagImageUrl(mediaItemRid)),
  );
}

/** The file name the item was uploaded under, minus our timestamp prefix. */
export async function getTagImageName(mediaItemRid: string): Promise<string> {
  return cachedPromise(nameCache, mediaItemRid, async () => {
    const info = await MediaSets.info(client, TAG_MEDIA_SET_RID, mediaItemRid);
    const path = info.path ?? mediaItemRid;
    return path.replace(/^\d+-/, "");
  });
}

/** Reads a local file into a texture so the paste preview is instant. */
export async function readLocalImage(
  file: File,
): Promise<{ texture: THREE.Texture; aspect: number }> {
  const url = URL.createObjectURL(file);
  try {
    return await textureFromUrl(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function textureFromUrl(url: string): Promise<{ texture: THREE.Texture; aspect: number }> {
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  const image = texture.image as HTMLImageElement;
  const aspect = image.height > 0 ? image.width / image.height : 1;
  return { texture, aspect };
}
