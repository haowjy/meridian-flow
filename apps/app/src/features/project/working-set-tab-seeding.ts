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
  reconcileContextRoutes,
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

export type ContextDeskReconciliationScope = {
  projectId: string;
  editorWorkId: string | null;
  generation: number;
};

type ContextDeskReconciliationGuard = (scope: ContextDeskReconciliationScope) => boolean;

export async function seedWorkingSetTabs({
  queryClient,
  routes,
  scope,
  isLiveScope,
}: {
  queryClient: QueryClient;
  routes: readonly WorkingSetRoute[];
  scope: ContextDeskReconciliationScope;
  isLiveScope: ContextDeskReconciliationGuard;
}): Promise<void> {
  const { projectId, editorWorkId } = scope;
  const results = await Promise.allSettled(
    routes.map(async (route) => {
      const workScoped = isWorkScopedProjectContextScheme(route.scheme);
      if (workScoped && route.workId !== editorWorkId) return { tab: null, removedRoute: null };
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
        return { tab: null, removedRoute: route };
      }
      if (!isLiveScope(scope)) return { tab: null, removedRoute: null };
      if (!isWorkingSetRouteDesired(route, readRecentRoutes(projectId))) {
        return { tab: null, removedRoute: null };
      }
      return { tab: contextTabFromFile(route.scheme, file, workId), removedRoute: null };
    }),
  );
  const fulfilled = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (!isLiveScope(scope)) return;
  const tabs = fulfilled.flatMap(({ tab }) => (tab ? [tab] : []));
  reconcileContextRoutes(projectId, {
    removedLocators: fulfilled.flatMap(({ removedRoute }) => removedRoute ?? []),
    survivingOwnedLocators: tabs.flatMap(
      (tab) => buildWorkingSetRoute(tab.scheme, tab.path, tab.workId) ?? [],
    ),
    promote: null,
    clearAll: false,
  });
  useContextTabsStore.getState().replaceTabs(projectId, tabs);
}

/** Refreshes restored tab metadata and drops routes that no longer exist. */
export async function validateContextDeskTabs({
  queryClient,
  scope,
  isLiveScope,
}: {
  queryClient: QueryClient;
  scope: ContextDeskReconciliationScope;
  isLiveScope: ContextDeskReconciliationGuard;
}): Promise<void> {
  const { projectId, editorWorkId } = scope;
  const restored = useContextTabsStore.getState().byProject[projectId]?.tabs ?? [];
  const results = await Promise.allSettled(
    restored.map(
      async (tab): Promise<{ tab: ContextTab | null; removedRoute: WorkingSetRoute | null }> => {
        if (tab.kind === "new") return { tab, removedRoute: null };
        const workScoped = isWorkScopedProjectContextScheme(tab.scheme);
        if (workScoped && tab.workId !== editorWorkId) return { tab: null, removedRoute: null };
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
          return {
            tab: null,
            removedRoute: buildWorkingSetRoute(tab.scheme, tab.path, tab.workId),
          };
        }
        return { tab: contextTabFromFile(tab.scheme, file, workId), removedRoute: null };
      },
    ),
  );
  const tabs = results.flatMap((result, index) => {
    // A transient tree read must not turn read degradation into destructive pruning.
    if (result.status === "rejected") {
      return [{ tab: restored[index] as ContextTab, removedRoute: null }];
    }
    return [result.value];
  });
  if (!isLiveScope(scope)) return;
  const survivingTabs = tabs.flatMap(({ tab }) => (tab ? [tab] : []));
  reconcileContextRoutes(projectId, {
    removedLocators: tabs.flatMap(({ removedRoute }) => removedRoute ?? []),
    survivingOwnedLocators: survivingTabs.flatMap((tab) =>
      tab.kind === "new" ? [] : (buildWorkingSetRoute(tab.scheme, tab.path, tab.workId) ?? []),
    ),
    promote: null,
    clearAll: false,
  });
  useContextTabsStore
    .getState()
    .reconcileTabs(projectId, new Set(restored.map((tab) => tab.documentId)), survivingTabs);
}
