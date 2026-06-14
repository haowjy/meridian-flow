// @ts-nocheck
/**
 * thread-title — localized thread-title helpers (default "New chat" fallback,
 * display normalization, and deriving a title from the first message). Single
 * source for how a thread's title renders.
 */
import { msg } from "@lingui/core/macro";

import { i18n } from "./i18n";

/** UI default when a thread has no stored title (DB allows NULL). */
const DEFAULT_THREAD_TITLE_MSG = msg`New chat`;

/** Localized "New chat" label, looked up from the active Lingui catalog. */
export function defaultThreadTitle(): string {
  return i18n._(DEFAULT_THREAD_TITLE_MSG);
}

export function displayThreadTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? trimmed : defaultThreadTitle();
}

/** Max length for a title derived from the first composer message. */
const DERIVED_TITLE_MAX = 40;

/**
 * Derive a provisional thread title from the first user message: collapse
 * whitespace, then trim to ~40 chars on a word boundary (with an ellipsis when
 * truncated). Used for the optimistic thread created from the Home composer;
 * Phase 5 lets the server replace it with a real summarized title.
 */
export function deriveTitleFromMessage(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return defaultThreadTitle();
  if (normalized.length <= DERIVED_TITLE_MAX) return normalized;

  const slice = normalized.slice(0, DERIVED_TITLE_MAX);
  const lastSpace = slice.lastIndexOf(" ");
  // Prefer a word boundary, but only if it keeps a reasonable amount of text.
  const head = lastSpace > DERIVED_TITLE_MAX * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${head.trimEnd()}…`;
}
