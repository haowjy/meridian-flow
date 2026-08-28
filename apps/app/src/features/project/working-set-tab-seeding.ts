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
import { findContextFile, findContextFileByDocumentId } from "./context/context-tree";

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

type SeededRoute = { tab: ContextTab | null; removedRoute: WorkingSetRoute | null };

function deviceOwnedTab(tab: ContextTab): boolean {
  return tab.kind === "new" || (tab.kind === "tracked" && tab.origin === "local-untitled");
}

export function mergeBootstrapDeskTabs(
  serverTabs: readonly ContextTab[],
  localResults: readonly ContextTab[],
): ContextTab[] {
  const byId = new Map(serverTabs.map((tab) => [tab.documentId, tab]));
  for (const local of localResults) {
    const server = byId.get(local.documentId);
    byId.set(
      local.documentId,
      server && local.kind === "tracked" && server.kind === "tracked"
        ? { ...server, origin: local.origin }
        : local,
    );
  }
  return [...byId.values()];
}

async function validateDeviceOwnedTabs(
  queryClient: QueryClient,
  projectId: string,
  tabs: readonly ContextTab[],
): Promise<ContextTab[]> {
  const results = await Promise.allSettled(
    tabs.filter(deviceOwnedTab).map(async (tab): Promise<ContextTab | null> => {
      if (tab.kind === "new") return tab;
      const workId = isWorkScopedProjectContextScheme(tab.scheme) ? (tab.workId ?? null) : null;
      const result = await queryClient.fetchQuery(
        projectContextTreeQueryOptions(projectId, tab.scheme, workId),
      );
      const file = findContextFileByDocumentId(result.tree, tab.documentId);
      if (!file) return null;
      const refreshed = contextTabFromFile(tab.scheme, file, workId);
      return refreshed.kind === "tracked" ? { ...refreshed, origin: "local-untitled" } : null;
    }),
  );
  const owned = tabs.filter(deviceOwnedTab);
  return results.flatMap((result, index) =>
    result.status === "rejected"
      ? [owned[index] as ContextTab]
      : result.value
        ? [result.value]
        : [],
  );
}

export function settleSeededRoutes(
  routes: readonly WorkingSetRoute[],
  restored: readonly ContextTab[],
  results: readonly PromiseSettledResult<SeededRoute>[],
): SeededRoute[] {
  const settled: SeededRoute[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      settled.push(result.value);
      return;
    }
    const route = routes[index];
    if (!route) return;
    const preserved = restored.find(
      (tab) =>
        tab.kind !== "new" &&
        tab.scheme === route.scheme &&
        tab.path === route.path &&
        (tab.workId ?? null) === (route.workId ?? null),
    );
    if (preserved) settled.push({ tab: preserved, removedRoute: null });
  });
  return settled;
}

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
  const { projectId } = scope;
  const restored = useContextTabsStore.getState().byProject[projectId]?.tabs ?? [];
  const results = await Promise.allSettled(
    routes.map(async (route) => {
      const workScoped = isWorkScopedProjectContextScheme(route.scheme);
      const workId: string | null = workScoped ? (route.workId ?? null) : null;
      const result = await queryClient.fetchQuery(
        projectContextTreeQueryOptions(projectId, route.scheme, workId),
      );
      const file = findContextFile(result.tree, route.path);
      if (!file) {
        // Each persisted route is validated in its own stored Work. The live
        // coordinator applies the currently selected Work after bootstrap.
        return { tab: null, removedRoute: route };
      }
      if (!isLiveScope(scope)) return { tab: null, removedRoute: null };
      if (!isWorkingSetRouteDesired(route, readRecentRoutes(projectId))) {
        return { tab: null, removedRoute: null };
      }
      return { tab: contextTabFromFile(route.scheme, file, workId), removedRoute: null };
    }),
  );
  const settled = settleSeededRoutes(routes, restored, results);
  const localTabs = await validateDeviceOwnedTabs(queryClient, projectId, restored);
  if (!isLiveScope(scope)) return;
  const serverTabs = settled.flatMap(({ tab }) => (tab ? [tab] : []));
  const tabs = mergeBootstrapDeskTabs(serverTabs, localTabs);
  reconcileContextRoutes(projectId, {
    removedLocators: settled.flatMap(({ removedRoute }) => removedRoute ?? []),
    survivingOwnedLocators: tabs.flatMap((tab) =>
      tab.kind === "new" ? [] : (buildWorkingSetRoute(tab.scheme, tab.path, tab.workId) ?? []),
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
  const { projectId } = scope;
  const restored = useContextTabsStore.getState().byProject[projectId]?.tabs ?? [];
  const results = await Promise.allSettled(
    restored.map(
      async (tab): Promise<{ tab: ContextTab | null; removedRoute: WorkingSetRoute | null }> => {
        if (tab.kind === "new") return { tab, removedRoute: null };
        const workScoped = isWorkScopedProjectContextScheme(tab.scheme);
        const workId = workScoped ? (tab.workId ?? null) : null;
        const result = await queryClient.fetchQuery(
          projectContextTreeQueryOptions(projectId, tab.scheme, workId),
        );
        const file =
          tab.kind === "tracked" && tab.origin === "local-untitled"
            ? findContextFileByDocumentId(result.tree, tab.documentId)
            : findContextFile(result.tree, tab.path);
        if (!file) {
          // Local provenance is validated by exact document identity; ordinary
          // restored server tabs remain route records and validate by locator.
          return {
            tab: null,
            removedRoute: buildWorkingSetRoute(tab.scheme, tab.path, tab.workId),
          };
        }
        const refreshed = contextTabFromFile(tab.scheme, file, workId);
        return {
          tab:
            tab.kind === "tracked" &&
            tab.origin === "local-untitled" &&
            refreshed.kind === "tracked"
              ? { ...refreshed, origin: "local-untitled" }
              : refreshed,
          removedRoute: null,
        };
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
