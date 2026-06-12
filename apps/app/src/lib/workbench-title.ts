// @ts-nocheck
/**
 * workbench-title — localized workbench-title display helpers (default "Untitled
 * workbench" fallback + display normalization). Single source for how a workbench's
 * title renders when missing/blank.
 */
import { msg } from "@lingui/core/macro";

import { i18n } from "./i18n";

/** UI default when a workbench has no stored title. */
const DEFAULT_WORKBENCH_TITLE_MSG = msg`Untitled workbench`;

export function defaultWorkbenchTitle(): string {
  return i18n._(DEFAULT_WORKBENCH_TITLE_MSG);
}

export function displayWorkbenchTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? trimmed : defaultWorkbenchTitle();
}
