/** Canonical server-tab locator identity shared by workspace mutations and routes. */

import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { ServerContextTab } from "./editor-workspace-model";

type Locator = Pick<ServerContextTab, "scheme" | "path" | "workId" | "rootThreadId" | "chatId">;

export function serverContextTabLocatorKey(tab: Locator): string {
  const owner = tab.chatId ?? tab.rootThreadId;
  if (owner) return `${tab.scheme}:chat:${owner}:${tab.path}`;
  return isWorkScopedScheme(tab.scheme)
    ? `${tab.scheme}:${tab.workId}:${tab.path}`
    : `${tab.scheme}:${tab.path}`;
}

export function sameServerContextTabLocator(left: Locator, right: Locator): boolean {
  return serverContextTabLocatorKey(left) === serverContextTabLocatorKey(right);
}
