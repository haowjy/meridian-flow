import { msg } from "@lingui/core/macro";

import { i18n } from "./i18n";

const DEFAULT_PROJECT_TITLE_MSG = msg`Untitled project`;

export function defaultProjectTitle(): string {
  return i18n._(DEFAULT_PROJECT_TITLE_MSG);
}

export function displayProjectTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? trimmed : defaultProjectTitle();
}
