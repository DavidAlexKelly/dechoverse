import { DEFAULT_JEV_MODEL } from "@/agents/brain/jev";

/**
 * The OpenRouter key and Jev model, shared by the /agents console and the
 * in-game command line.
 *
 * Two sources, the first that has a value winning:
 *
 * 1. whatever was typed this browser session ("jevkey …" or the console),
 *    so a key can be tried or switched off without a rebuild;
 * 2. VITE_OPENROUTER_API_KEY / VITE_JEV_MODEL from the .env files.
 *
 * ⚠ Vite inlines VITE_* variables into the JavaScript bundle, so a key set
 * in .env.production can be read by anyone who can load the app. Give it a
 * credit limit in the OpenRouter dashboard.
 */
const ENV_KEY: string = (import.meta.env.VITE_OPENROUTER_API_KEY as string | undefined) ?? "";
const ENV_MODEL: string = (import.meta.env.VITE_JEV_MODEL as string | undefined) ?? "";

/** Placeholder values like "<your key>" count as unset. */
function envValue(value: string): string {
  const trimmed = value.trim();
  return /^<.*>$/.test(trimmed) ? "" : trimmed;
}

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

/** "off" typed this session overrides the .env key too. */
const OFF = "off";

export function storedJevKey(): string {
  const typed = read(KEY_STORAGE);
  if (typed === OFF) {
    return "";
  }
  return typed || envValue(ENV_KEY);
}

export function storedJevModel(): string {
  return read(MODEL_STORAGE) || envValue(ENV_MODEL) || DEFAULT_JEV_MODEL;
}

/** Switches Jev off for this session, even when .env provides a key. */
export function storeJevOff(): void {
  write(KEY_STORAGE, OFF);
}

export function storeJev(key: string, model: string): void {
  write(KEY_STORAGE, key.trim());
  write(MODEL_STORAGE, model.trim());
}
