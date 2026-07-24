/**
 * Page-stable rotating prompts for the chat composer.
 *
 * Each pool advances once when the browser loads this module. Components can
 * render repeatedly without consuming more entries.
 */
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useSyncExternalStore } from "react";

export const COMPOSE_PLACEHOLDERS = [
  msg`Chat away`,
  msg`Write away`,
  msg`Go ahead`,
  msg`What's next?`,
  msg`What's on your mind?`,
  msg`Brainstorm away`,
  msg`Talk it out`,
  msg`Thinking out loud?`,
  msg`Where were we?`,
  msg`Let's work on it`,
] as const;

export const INTERJECT_PLACEHOLDERS = [
  msg`Interject`,
  msg`Chime in`,
  msg`Actually…`,
  msg`Hold on…`,
  msg`Quick thought`,
] as const;

const COMPOSE_LS_KEY = "meridian:placeholderIdx:compose";
const INTERJECT_LS_KEY = "meridian:placeholderIdx:interject";
const SERVER_PLACEHOLDERS = {
  compose: COMPOSE_PLACEHOLDERS[0],
  interject: INTERJECT_PLACEHOLDERS[0],
};

type PlaceholderSelection<T> = {
  index: number;
  value: T;
};

export function selectNextPlaceholder<T>(
  pool: readonly T[],
  storedIndex: string | null,
): PlaceholderSelection<T> {
  if (pool.length === 0) {
    throw new Error("Placeholder pools must not be empty");
  }

  const parsedIndex = Number.parseInt(storedIndex ?? "-1", 10);
  const lastIndex =
    Number.isInteger(parsedIndex) && parsedIndex >= 0 && parsedIndex < pool.length
      ? parsedIndex
      : -1;
  const index = (lastIndex + 1) % pool.length;

  return { index, value: pool[index] as T };
}

function advancePool<T>(storage: Storage, key: string, pool: readonly T[]): T {
  let storedIndex: string | null = null;
  try {
    storedIndex = storage.getItem(key);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }

  const selection = selectNextPlaceholder(pool, storedIndex);
  try {
    storage.setItem(key, String(selection.index));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return selection.value;
}

function selectPagePlaceholders(): {
  compose: MessageDescriptor;
  interject: MessageDescriptor;
} {
  if (typeof window === "undefined") {
    return SERVER_PLACEHOLDERS;
  }

  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return SERVER_PLACEHOLDERS;
  }
  return {
    compose: advancePool(storage, COMPOSE_LS_KEY, COMPOSE_PLACEHOLDERS),
    interject: advancePool(storage, INTERJECT_LS_KEY, INTERJECT_PLACEHOLDERS),
  };
}

const PAGE_PLACEHOLDERS = selectPagePlaceholders();
const subscribeToNoChanges = () => () => {};

export function useComposerPlaceholder(streaming: boolean): string {
  const { i18n } = useLingui();
  const placeholder = useSyncExternalStore(
    subscribeToNoChanges,
    () => (streaming ? PAGE_PLACEHOLDERS.interject : PAGE_PLACEHOLDERS.compose),
    () => (streaming ? SERVER_PLACEHOLDERS.interject : SERVER_PLACEHOLDERS.compose),
  );

  return i18n._(placeholder);
}
