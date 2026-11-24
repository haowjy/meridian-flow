import { msg } from "@lingui/core/macro";

import { i18n } from "./i18n";

const DEFAULT_THREAD_TITLE_MSG = msg`Untitled chat`;

/** Localized "Untitled chat" label, looked up from the active Lingui catalog. */
export function defaultThreadTitle(): string {
  return i18n._(DEFAULT_THREAD_TITLE_MSG);
}

export function displayThreadTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? trimmed : defaultThreadTitle();
}

const DERIVED_TITLE_MAX = 40;

const MARKDOWN_LINK = /!?\[([^\]]*)\]\((?:<[^>]*>|[^)\s]*)\)/g;

export function deriveTitleFromMessage(text: string): string {
  const normalized = text.replace(MARKDOWN_LINK, "$1").replace(/\s+/g, " ").trim();
  if (!normalized) return defaultThreadTitle();
  if (normalized.length <= DERIVED_TITLE_MAX) return normalized;

  const slice = normalized.slice(0, DERIVED_TITLE_MAX);
  const lastSpace = slice.lastIndexOf(" ");
  const head = lastSpace > DERIVED_TITLE_MAX * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${head.trimEnd()}…`;
}
