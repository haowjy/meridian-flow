/** Canonical server-tab locator identity shared by workspace mutations and routes. */

import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

import type { ServerContextTab } from "./editor-workspace-model";

type Locator = Pick<ServerContextTab, "scheme" | "path" | "workId" | "rootThreadId">;

export function serverContextTabLocatorKey(tab: Locator): string {
  if (!isWorkScopedProjectContextScheme(tab.scheme)) return `${tab.scheme}:${tab.path}`;
  return `${tab.scheme}:${tab.rootThreadId ? `chat:${tab.rootThreadId}` : tab.workId}:${tab.path}`;
}

export function sameServerContextTabLocator(left: Locator, right: Locator): boolean {
  return serverContextTabLocatorKey(left) === serverContextTabLocatorKey(right);
}
