// @ts-nocheck
/**
 * project-title — localized project-title display helpers (default "Untitled
 * project" fallback + display normalization). Single source for how a project's
 * title renders when missing/blank.
 */
import { msg } from "@lingui/core/macro";

import { i18n } from "./i18n";

/** UI default when a project has no stored title. */
const DEFAULT_PROJECT_TITLE_MSG = msg`Untitled project`;

export function defaultProjectTitle(): string {
  return i18n._(DEFAULT_PROJECT_TITLE_MSG);
}

export function displayProjectTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? trimmed : defaultProjectTitle();
}
