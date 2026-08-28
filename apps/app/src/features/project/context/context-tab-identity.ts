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

import type { ContextTab } from "@/client/stores";

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
