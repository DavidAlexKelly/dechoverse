import { DEFAULT_JEV_MODEL } from "@/agents/brain/jev";

/**
 * The OpenRouter key and Jev model, shared by the /agents console and the
 * in-game command line.
 *
 * Session storage only: the key lasts until the browser is closed and is
 * never written into the bundle, which every Dechoverse player downloads.
 */
const KEY_STORAGE = "dechoverse-openrouter-key";
const MODEL_STORAGE = "dechoverse-jev-model";

function read(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    if (value === "") {
      window.sessionStorage.removeItem(key);
    } else {
      window.sessionStorage.setItem(key, value);
    }
  } catch {
    // Not remembered; typed again next time.
  }
}

export function storedJevKey(): string {
  return read(KEY_STORAGE);
}

export function storedJevModel(): string {
  return read(MODEL_STORAGE) || DEFAULT_JEV_MODEL;
}

export function storeJev(key: string, model: string): void {
  write(KEY_STORAGE, key.trim());
  write(MODEL_STORAGE, model.trim());
}
