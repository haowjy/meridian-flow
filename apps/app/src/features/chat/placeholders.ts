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

const AT_REFERENCE_HINT = msg`@ for reference`;
const COMPOSE_LS_KEY = "meridian:placeholderIdx:compose";
const INTERJECT_LS_KEY = "meridian:placeholderIdx:interject";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
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
  try {
    const selection = selectNextPlaceholder(pool, storage.getItem(key));
    storage.setItem(key, String(selection.index));
    return selection.value;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
    return pool[0] as T;
  }
}

function selectPagePlaceholders(): {
  compose: MessageDescriptor;
  interject: MessageDescriptor;
} {
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
  hint: string,
  lastUsed: number | null,
  enabled: boolean,
  now = Date.now(),
): string {
  return enabled && shouldShowAtReferenceHint(lastUsed, now)
    ? `${placeholder}, ${hint}`
    : placeholder;
}

export function getComposePlaceholder(): MessageDescriptor {
  return PAGE_PLACEHOLDERS.compose;
}

export function getInterjectPlaceholder(): MessageDescriptor {
  return PAGE_PLACEHOLDERS.interject;
}

const subscribeToNoChanges = () => () => {};

export function useComposerPlaceholder(
  streaming: boolean,
  lastAtUsed: number | null = null,
): string {
  const { i18n } = useLingui();
  const placeholder = useSyncExternalStore(
    subscribeToNoChanges,
    () => (streaming ? getInterjectPlaceholder() : getComposePlaceholder()),
    () => (streaming ? SERVER_PLACEHOLDERS.interject : SERVER_PLACEHOLDERS.compose),
  );

  // TODO: Enable and pass the last-use timestamp when v3 supports @ mentions.
  return appendAtReferenceHint(i18n._(placeholder), i18n._(AT_REFERENCE_HINT), lastAtUsed, false);
}
