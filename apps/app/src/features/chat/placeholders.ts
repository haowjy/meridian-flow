/**
 * Page-stable rotating prompts for the chat composer.
 *
 * Each pool advances once when the browser loads this module. Components can
 * render repeatedly without consuming more entries.
 */
import { useSyncExternalStore } from "react";

export const COMPOSE_PLACEHOLDERS = [
  "Chat away",
  "Write away",
  "Go ahead",
  "What's next?",
  "What's on your mind?",
  "Brainstorm away",
  "Talk it out",
  "Thinking out loud?",
  "Where were we?",
  "Let's work on it",
] as const;

export const INTERJECT_PLACEHOLDERS = [
  "Interject",
  "Chime in",
  "Actually...",
  "Hold on...",
  "Quick thought",
] as const;

const COMPOSE_LS_KEY = "meridian:placeholderIdx:compose";
const INTERJECT_LS_KEY = "meridian:placeholderIdx:interject";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SERVER_PLACEHOLDERS = {
  compose: COMPOSE_PLACEHOLDERS[0],
  interject: INTERJECT_PLACEHOLDERS[0],
};

type PlaceholderSelection = {
  index: number;
  value: string;
};

export function selectNextPlaceholder(
  pool: readonly string[],
  storedIndex: string | null,
): PlaceholderSelection {
  if (pool.length === 0) {
    throw new Error("Placeholder pools must not be empty");
  }

  const parsedIndex = Number.parseInt(storedIndex ?? "-1", 10);
  const lastIndex =
    Number.isInteger(parsedIndex) && parsedIndex >= 0 && parsedIndex < pool.length
      ? parsedIndex
      : -1;
  const index = (lastIndex + 1) % pool.length;

  return { index, value: pool[index] as string };
}

function advancePool(storage: Storage, key: string, pool: readonly string[]): string {
  try {
    const selection = selectNextPlaceholder(pool, storage.getItem(key));
    storage.setItem(key, String(selection.index));
    return selection.value;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
    return pool[0] as string;
  }
}

function selectPagePlaceholders(): { compose: string; interject: string } {
  if (typeof window === "undefined") {
    return SERVER_PLACEHOLDERS;
  }

  try {
    return {
      compose: advancePool(window.localStorage, COMPOSE_LS_KEY, COMPOSE_PLACEHOLDERS),
      interject: advancePool(window.localStorage, INTERJECT_LS_KEY, INTERJECT_PLACEHOLDERS),
    };
  } catch {
    return SERVER_PLACEHOLDERS;
  }
}

const PAGE_PLACEHOLDERS = selectPagePlaceholders();

export function shouldShowAtReferenceHint(lastUsed: number | null, now = Date.now()): boolean {
  return lastUsed === null || now - lastUsed > SEVEN_DAYS_MS;
}

export function appendAtReferenceHint(
  placeholder: string,
  lastUsed: number | null,
  enabled: boolean,
  now = Date.now(),
): string {
  return enabled && shouldShowAtReferenceHint(lastUsed, now)
    ? `${placeholder}, @ for reference`
    : placeholder;
}

export function getComposePlaceholder(lastAtUsed: number | null = null): string {
  // TODO: Enable and pass the last-use timestamp when v3 supports @ mentions.
  return appendAtReferenceHint(PAGE_PLACEHOLDERS.compose, lastAtUsed, false);
}

export function getInterjectPlaceholder(): string {
  return PAGE_PLACEHOLDERS.interject;
}

const subscribeToNoChanges = () => () => {};

export function useComposerPlaceholder(
  streaming: boolean,
  lastAtUsed: number | null = null,
): string {
  return useSyncExternalStore(
    subscribeToNoChanges,
    () => (streaming ? getInterjectPlaceholder() : getComposePlaceholder(lastAtUsed)),
    () => (streaming ? SERVER_PLACEHOLDERS.interject : SERVER_PLACEHOLDERS.compose),
  );
}
