/**
 * context-tab-identity — route/tab matching for work-scoped context files.
 *
 * Work-scoped schemes (`scratch`, `uploads`) share path shape across works; tab and
 * route reconciliation must include `workId` so switching active work cannot
 * reuse another work's open tab.
 */
import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";

import type { ContextTab, ServerContextTab } from "@/client/stores";

export function contextTabMatchesRoute(
  tab: ContextTab,
  scheme: ProjectContextTreeScheme,
  path: string,
  workId: string | null,
): boolean {
  if (tab.kind === "new") return false;
  if (tab.scheme !== scheme || tab.path !== path) return false;
  if (isWorkScopedProjectContextScheme(scheme)) return tab.workId === workId;
  return true;
}

export function contextTabRouteKey(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  path: string,
  workId: string | null,
): string {
  if (isWorkScopedProjectContextScheme(scheme) && workId) {
    return `${projectId}:${scheme}:${workId}:${path}`;
  }
  return `${projectId}:${scheme}:${path}`;
}

export function findContextTabForRoute(
  tabs: ContextTab[],
  scheme: ProjectContextTreeScheme | null,
  path: string | null,
  workId: string | null,
): ServerContextTab | null {
  if (scheme === null || path === null) return null;
  return (
    tabs.find(
      (tab): tab is ServerContextTab =>
        tab.kind !== "new" && contextTabMatchesRoute(tab, scheme, path, workId),
    ) ?? null
  );
}
