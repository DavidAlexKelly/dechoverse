/**
 * Text to speech for proximity chat, on top of the browser's Web Speech API.
 *
 * Worth knowing up front: speechSynthesis is *not* spatial. It plays through
 * the default output and exposes no audio buffer, so it cannot be routed into
 * a Three.js PositionalAudio. Distance therefore scales utterance.volume and
 * nothing else — there is no panning and no occlusion. Real 3D voice would
 * need a TTS service that returns audio, which is out of scope here.
 */

/** Longest message that will be sent, spoken or displayed. */
export const MAX_MESSAGE_LENGTH = 200;

const MUTE_KEY = "fps-chat-muted";

/** Rough speaking rate, used to predict how long an utterance will last. */
const CHARS_PER_SECOND = 13;
const SPEECH_PADDING_MS = 400;
const MIN_SPEECH_MS = 600;
const MAX_SPEECH_MS = 15000;

/**
 * How long the bubble stays up after the words have finished.
 *
 * Speech duration alone is not a sensible bubble lifetime: "hello there" takes
 * about a second to say, and a bubble that lives exactly that long just
 * flashes. The words stopping is the cue to start clearing it, not the moment
 * it should vanish.
 */
const BUBBLE_LINGER_MS = 1800;
/** Nothing disappears faster than this, however short the message. */
const MIN_BUBBLE_MS = 3200;
const MAX_BUBBLE_MS = 16000;

/** Utterances queued beyond this are dropped rather than piling up. */
const MAX_QUEUED = 2;

let queued = 0;
let primed = false;
let cachedVoices: SpeechSynthesisVoice[] | null = null;

export function isSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Shouting needs at least this many characters, so a stray "A" is not one. */
const MIN_SHOUT_LENGTH = 2;

/**
 * True when a message is written in capitals, which the game treats as
 * shouting: louder, and audible from further away.
 *
 * The test is that the text has cased letters *and* none of them are
 * lowercase. Comparing against toUpperCase alone would call "123!" a shout,
 * since digits and punctuation are unchanged by either conversion.
 *
 * Derived from the text rather than sent on the wire, so every listener
 * reaches the same conclusion with nothing extra to keep in sync — the same
 * approach the bubble duration takes.
 */
export function isShout(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_SHOUT_LENGTH) {
    return false;
  }
  return trimmed !== trimmed.toLowerCase() && trimmed === trimmed.toUpperCase();
}

/**
 * Roughly how long the words themselves take to say.
 *
 * A pure function of the text, so every client agrees without anything extra
 * traveling on the wire — the same approach worldgen.ts takes to terrain.
 * Deriving it from the local `onend` event instead would desynchronise
 * bubbles, because every listener has a different voice, rate and audio
 * state, and anyone whose speech engine is unavailable would never expire the
 * bubble at all.
 */
export function estimateSpeechMs(text: string): number {
  const spoken = (text.length / CHARS_PER_SECOND) * 1000 + SPEECH_PADDING_MS;
  return Math.min(MAX_SPEECH_MS, Math.max(MIN_SPEECH_MS, Math.round(spoken)));
}

/**
 * How long a message stays on screen — speech plus a linger, floored so that
 * even one word is readable.
 *
 * This is display policy, kept separate from the speech estimate above on
 * purpose: the two want different floors. It is also what gates sending the
 * next message, so the ceiling matters — a value that could hang would mute
 * the player permanently.
 */
export function bubbleDurationMs(text: string): number {
  return Math.min(
    MAX_BUBBLE_MS,
    Math.max(MIN_BUBBLE_MS, estimateSpeechMs(text) + BUBBLE_LINGER_MS),
  );
}

export function isMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "true" : "false");
  } catch {
    // A blocked localStorage should not stop the toggle from taking effect.
  }
  if (muted) {
    cancelSpeech();
  }
}

/**
 * Voices load asynchronously — getVoices() is usually empty on first call and
 * only fills in once the engine has enumerated them, so the cache is cleared
 * on voiceschanged rather than populated once.
 */
function voiceList(): SpeechSynthesisVoice[] {
  if (!isSpeechAvailable()) {
    return [];
  }
  if (cachedVoices != null && cachedVoices.length > 0) {
    return cachedVoices;
  }
  const all = window.speechSynthesis.getVoices();
  if (all.length === 0) {
    return [];
  }
  // Prefer voices in the page's language; a German voice reading English is
  // technically speech but not much use.
  const prefix = (navigator.language || "en").slice(0, 2).toLowerCase();
  const preferred = all.filter((voice) => voice.lang.toLowerCase().startsWith(prefix));
  cachedVoices = preferred.length > 0 ? preferred : all;
  return cachedVoices;
}

if (isSpeechAvailable()) {
  try {
    window.speechSynthesis.addEventListener("voiceschanged", () => {
      cachedVoices = null;
    });
  } catch {
    // Older engines only expose the onvoiceschanged property.
    window.speechSynthesis.onvoiceschanged = (): void => {
      cachedVoices = null;
    };
  }
}

/**
 * Unlocks audio on the first user gesture.
 *
 * Browsers refuse synthesised speech until the page has been interacted with.
 * This app always has a gesture to hand — you must click to lock the pointer
 * before you can move — so priming on the first pointerdown is enough.
 */
export function primeSpeech(): void {
  if (primed || !isSpeechAvailable()) {
    return;
  }
  primed = true;
  try {
    const utterance = new SpeechSynthesisUtterance("");
    utterance.volume = 0;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Priming is best effort; speaking later may still work.
  }
}

export function cancelSpeech(): void {
  if (!isSpeechAvailable()) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Nothing useful to do if the engine refuses.
  }
  queued = 0;
}

/** Stable hash, matching how Avatars picks a colour per player. */
function hashOf(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100000;
  }
  return hash;
}

export interface SpeakOptions {
  /** 0..1, already attenuated for distance by the caller. */
  volume: number;
  /** Stable per-speaker seed, so a player always sounds like themselves. */
  seed: string;
}

export function speak(text: string, { volume, seed }: SpeakOptions): void {
  if (!isSpeechAvailable() || isMuted()) {
    return;
  }
  const trimmed = text.trim();
  if (trimmed === "" || volume <= 0) {
    return;
  }
  // speechSynthesis queues by default, so without a cap a crowded room — or
  // one determined spammer — could hold the audio channel for minutes.
  if (queued >= MAX_QUEUED) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(trimmed.slice(0, MAX_MESSAGE_LENGTH));
  const voices = voiceList();
  const hash = hashOf(seed);
  if (voices.length > 0) {
    utterance.voice = voices[hash % voices.length];
  }
  // Spread rate and pitch a little as well, so two speakers are still told
  // apart when the platform only offers a single voice.
  utterance.rate = 0.95 + ((hash >> 3) % 5) * 0.05;
  utterance.pitch = 0.85 + ((hash >> 7) % 6) * 0.09;
  utterance.volume = Math.max(0, Math.min(1, volume));

  queued += 1;
  const release = (): void => {
    queued = Math.max(0, queued - 1);
  };
  utterance.onend = release;
  utterance.onerror = release;

  try {
    window.speechSynthesis.speak(utterance);
  } catch {
    release();
  }
}
