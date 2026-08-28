/** Canonical server-tab locator identity shared by desk mutations and routes. */

import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

import type { ServerContextTab } from "./context-tabs-store";

export function serverContextTabLocatorKey(
  tab: Pick<ServerContextTab, "scheme" | "path" | "workId">,
): string {
  return isWorkScopedProjectContextScheme(tab.scheme)
    ? `${tab.scheme}:${tab.workId ?? ""}:${tab.path}`
    : `${tab.scheme}:${tab.path}`;
}

export function sameServerContextTabLocator(
  left: Pick<ServerContextTab, "scheme" | "path" | "workId">,
  right: Pick<ServerContextTab, "scheme" | "path" | "workId">,
): boolean {
  return serverContextTabLocatorKey(left) === serverContextTabLocatorKey(right);
}
