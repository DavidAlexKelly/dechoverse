import { Folders, Spaces } from "@osdk/foundry.filesystem";
import client from "@/foundry/client";

/** A Foundry Space, rendered as a shootable block in the first level. */
export interface SpaceNode {
  rid: string;
  name: string;
  path: string;
}

/** Anything that lives inside a Space: a project, a folder or a resource. */
export interface FsNode {
  rid: string;
  name: string;
  path: string;
  /** Compass resource type, e.g. FOUNDRY_DATASET or WORKSHOP_MODULE. */
  type: string;
  /** True for Compass folders, i.e. projects and plain folders you can enter. */
  isFolder: boolean;
}

const MAX_SPACES = 60;
const MAX_CHILDREN = 80;

/** Compass folders (projects included) all share the same rid prefix. */
function isCompassFolder(rid: string): boolean {
  return rid.startsWith("ri.compass.main.folder.");
}

/** Lists every Space the signed in user can see, using the Platform SDK. */
export async function listSpaces(): Promise<SpaceNode[]> {
  const spaces: SpaceNode[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const page = await Spaces.list(client, { pageSize: 100, pageToken });
    for (const space of page.data) {
      spaces.push({
        rid: space.rid,
        name: space.displayName,
        path: space.path,
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken != null && spaces.length < MAX_SPACES);

  return spaces.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SPACES);
}

/**
 * Lists the direct children of a Space, project or folder: nested folders come
 * first, then the resources (datasets, workshops, repositories, ...).
 */
export async function listChildren(folderRid: string): Promise<FsNode[]> {
  const nodes: FsNode[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const page = await Folders.children(client, folderRid, {
      pageSize: 200,
      pageToken,
    });
    for (const resource of page.data) {
      if (resource.trashStatus !== "NOT_TRASHED") {
        continue;
      }
      nodes.push({
        rid: resource.rid,
        name: resource.displayName,
        path: resource.path,
        type: resource.type,
        isFolder: isCompassFolder(resource.rid),
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken != null && nodes.length < MAX_CHILDREN);

  return nodes
    .sort((a, b) => {
      if (a.isFolder !== b.isFolder) {
        return a.isFolder ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_CHILDREN);
}

/** Turns FOUNDRY_DATASET into "Foundry dataset" for the HUD. */
export function humanizeType(type: string): string {
  const words = type.toLowerCase().split("_");
  return words
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}
