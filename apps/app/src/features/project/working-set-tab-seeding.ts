/** Re-materializes hydrated working-set routes as inactive, tree-validated tabs. */

import {
  isWorkScopedProjectContextScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import { projectContextTreeQueryOptions } from "@/client/query/useProjectContextTree";
import type { ContextTab } from "@/client/stores";
import { useContextTabsStore } from "@/client/stores";
import type { WorkingSetHydrationPlan } from "@/client/working-set";
import {
  buildWorkingSetRoute,
  readRecentRoutes,
  removeRoute,
  workingSetRouteEquals,
} from "@/client/working-set";
import { contextTabFromFile } from "./context/context-tab-from-file";
import { findContextFile } from "./context/context-tree";

export function contextDeskReconciliation(
  hydration: WorkingSetHydrationPlan,
): "server-replace" | "local-keep" {
  return hydration.status === "server" ? "server-replace" : "local-keep";
}

export function isWorkingSetRouteDesired(
  route: WorkingSetRoute,
  currentRoutes: readonly WorkingSetRoute[],
): boolean {
  return currentRoutes.some((candidate) => workingSetRouteEquals(candidate, route));
}

export async function seedWorkingSetTabs({
  queryClient,
  projectId,
  routes,
  routeWorkId,
}: {
  queryClient: QueryClient;
  projectId: string;
  routes: readonly WorkingSetRoute[];
  routeWorkId: string | null;
}): Promise<void> {
  const results = await Promise.allSettled(
    routes.map(async (route) => {
      const workScoped = isWorkScopedProjectContextScheme(route.scheme);
      if (workScoped && route.workId !== routeWorkId) return null;
      const workId: string | null = workScoped ? (route.workId ?? null) : null;
      const result = await queryClient.fetchQuery(
        projectContextTreeQueryOptions(projectId, route.scheme, workId),
      );
      const file = findContextFile(result.tree, route.path);
      if (!file) {
        // Validated-missing on the server-adoption branch too: a fresh tree
        // lacks the path, so drop the dead route from the working set instead
        // of letting it occupy a synced slot forever. (Work-scope skips above
        // never remove — the route may be valid under its own work.)
        removeRoute(projectId, route);
        return null;
      }
      if (!isWorkingSetRouteDesired(route, readRecentRoutes(projectId))) return null;
      return contextTabFromFile(route.scheme, file, workId);
    }),
  );
  const tabs = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
  useContextTabsStore.getState().replaceTabs(projectId, tabs);
}

/** Refreshes restored tab metadata and drops routes that no longer exist. */
export async function validateContextDeskTabs({
  queryClient,
  projectId,
  routeWorkId,
}: {
  queryClient: QueryClient;
  projectId: string;
  routeWorkId: string | null;
}): Promise<void> {
  const restored = useContextTabsStore.getState().byProject[projectId]?.tabs ?? [];
  const results = await Promise.allSettled(
    restored.map(async (tab): Promise<ContextTab | null> => {
      if (tab.kind === "new") return tab;
      const workScoped = isWorkScopedProjectContextScheme(tab.scheme);
      if (workScoped && tab.workId !== routeWorkId) return null;
      const workId = workScoped ? (tab.workId ?? null) : null;
      const result = await queryClient.fetchQuery(
        projectContextTreeQueryOptions(projectId, tab.scheme, workId),
      );
      const file = findContextFile(result.tree, tab.path);
      if (!file) {
        // Validated-missing (fresh tree lacks the path): drop the tab AND its
        // remembered route so a dead route doesn't occupy a synced slot
        // forever. Work-scope skips above deliberately do NOT remove — the
        // route may still be valid under its own work.
        const route = buildWorkingSetRoute(tab.scheme, tab.path, tab.workId);
        if (route) removeRoute(projectId, route);
        return null;
      }
      return contextTabFromFile(tab.scheme, file, workId);
    }),
  );
  const tabs = results.flatMap((result, index) => {
    // A transient tree read must not turn read degradation into destructive pruning.
    if (result.status === "rejected") return [restored[index] as ContextTab];
    return result.value ? [result.value] : [];
  });
  useContextTabsStore
    .getState()
    .reconcileTabs(projectId, new Set(restored.map((tab) => tab.documentId)), tabs);
}
