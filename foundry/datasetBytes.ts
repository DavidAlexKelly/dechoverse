/**
 * Whole files out of a Foundry dataset, held for as long as something is
 * reading them.
 *
 * WHY WHOLE FILES, WHEN PMTILES IS BUILT FOR RANGES
 * -------------------------------------------------
 * A PMTiles archive is an index followed by tens of thousands of tiles, and the
 * format exists so that a reader can take the header, then a directory, then
 * the handful of tiles it wants — a few tens of kilobytes out of a chunk that
 * may be tens of megabytes. Doing that means setting a Range header, which
 * means calling fetch with a URL this code assembles, which the code scanner
 * rightly refuses: it cannot tell a dataset path from an attacker's, and a rule
 * that waves through "the URL is fine, trust me" is worth less than the
 * bandwidth it saves.
 *
 * So the archive is fetched whole, through the Platform SDK, exactly as this
 * app already reads its models and its DEM chunks — and the tile reader is
 * handed an in-memory source, which turns every range into a slice. One
 * download instead of a dozen small ones; more bytes, fewer round trips, and
 * nothing hand-rolled about the transport.
 *
 * It is affordable here only because of what reads it: roads are cosmetic and
 * load in the background after the player has arrived. Anything on the critical
 * path should not be built on this.
 */
import { Datasets } from "@osdk/foundry";
import client from "@/foundry/client";

const BRANCH = "master";

const files = new Map<string, Promise<ArrayBuffer>>();

function fileKey(datasetRid: string, path: string): string {
  return `${datasetRid}|${path}`;
}

/** The whole file, fetched at most once per session. */
export function getFile(datasetRid: string, path: string): Promise<ArrayBuffer> {
  const key = fileKey(datasetRid, path);
  const existing = files.get(key);
  if (existing != null) {
    return existing;
  }

  const promise = (async () => {
    const response = await Datasets.Files.content(client, datasetRid, path, {
      branchName: BRANCH,
    });
    return response.arrayBuffer();
  })().catch((err: unknown) => {
    // A failed read is worth retrying; a cached rejection is not.
    files.delete(key);
    throw err;
  });

  files.set(key, promise);
  return promise;
}

/** Parsed JSON from a dataset file. */
export async function getJson<T>(datasetRid: string, path: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await getFile(datasetRid, path))) as T;
}

/** Drop a cached file, for anything that will not be read again. */
export function releaseFile(datasetRid: string, path: string): void {
  files.delete(fileKey(datasetRid, path));
}
