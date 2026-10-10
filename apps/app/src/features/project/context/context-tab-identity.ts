/**
 * context-tab-identity — route/tab matching for work-scoped context files.
 *
 * Work-scoped schemes (`scratch`, `uploads`) share path shape across works and
 * a No Work chat's Scratch shares it across lineages; tab and route
 * reconciliation must include the owner (`workId` or `rootThreadId`) so
 * switching active work cannot reuse another owner's open tab.
 */
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

import type { ContextTab } from "@/client/stores";
import type { ContextRouteTarget } from "../routing/project-route";

type RouteLocator = Pick<ContextRouteTarget, "scheme" | "path" | "workId" | "rootThreadId">;

export function contextTabMatchesRoute(tab: ContextTab, target: RouteLocator): boolean {
  if (tab.kind === "new") return false;
  if (tab.scheme !== target.scheme || tab.path !== target.path) return false;
  if (!isWorkScopedProjectContextScheme(target.scheme)) return true;
  return target.rootThreadId !== undefined
    ? tab.rootThreadId === target.rootThreadId
    : tab.rootThreadId === undefined && tab.workId === target.workId;
}

export function contextTabRouteKey(projectId: string, target: RouteLocator): string {
  if (isWorkScopedProjectContextScheme(target.scheme)) {
    const owner = target.rootThreadId ? `chat:${target.rootThreadId}` : target.workId;
    return `${projectId}:${target.scheme}:${owner}:${target.path}`;
  }
  return `${projectId}:${target.scheme}:${target.path}`;
}
