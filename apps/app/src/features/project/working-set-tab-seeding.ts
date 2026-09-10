/** Re-materializes hydrated working-set routes as inactive, tree-validated tabs. */

import {
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
  type ProjectContextIdentityResolution,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { fetchContextCatalogView, projectCatalogFile } from "@/client/query/useContextCatalog";
import {
  type ContextTab,
  reconcileContextDeskBootstrap,
  useContextTabsStore,
} from "@/client/stores";
import type { WorkingSetHydrationPlan } from "@/client/working-set";
import {
  readRecentRoutes,
  reconcileContextRoutes,
  workingSetRouteEquals,
} from "@/client/working-set";
import { workingSetRouteForTab } from "./context/context-removal-planner";
import { contextTabFromFile } from "./context/context-tab-from-file";

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

function availableTab(
  resolution: Extract<ProjectContextIdentityResolution, { kind: "available" }>,
): ContextTab {
  const scheme = resolution.entry.uri.slice(0, resolution.entry.uri.indexOf(":"));
  if (!isProjectContextTreeScheme(scheme)) throw new TypeError("Invalid available route scheme");
  const workId = isWorkScopedProjectContextScheme(scheme)
    ? resolution.authority.kind === "work"
      ? resolution.authority.workId
      : resolution.authority.kind === "none"
        ? null
        : undefined
    : undefined;
  if (isWorkScopedProjectContextScheme(scheme) && workId === undefined) {
    throw new TypeError("Invalid available route authority");
  }
  return contextTabFromFile(scheme, projectCatalogFile(resolution.entry), workId);
}

async function restoreServerRoute(projectId: string, route: WorkingSetRoute): Promise<SeededRoute> {
  const result = await lookupProjectContextAvailability(projectId, [route.documentId]);
  const resolution = result.resolutions[0];
  if (!resolution || resolution.documentId !== route.documentId) {
    throw new TypeError("Invalid project availability response");
  }
  if (resolution.kind === "available") {
    const tab = availableTab(resolution);
    if (tab.documentId !== route.documentId) {
      throw new TypeError("Availability entry does not match its stable identity");
    }
    return { tab, removedRoute: route };
  }
  if (resolution.kind === "indeterminate") throw new Error("Document identity is indeterminate");
  return { tab: null, removedRoute: route };
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
      const result = await fetchContextCatalogView(queryClient, projectId, tab.scheme, workId);
      const file = result.findDocument(tab.documentId);
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
        tab.documentId === route.documentId &&
        workingSetRouteEquals(workingSetRouteForTab(tab) ?? undefined, route),
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
      const restored = await restoreServerRoute(projectId, route);
      if (!isLiveScope(scope)) return { tab: null, removedRoute: null };
      if (!isWorkingSetRouteDesired(route, readRecentRoutes(projectId))) {
        return { tab: null, removedRoute: null };
      }
      return restored;
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
      tab.kind === "new" ? [] : (workingSetRouteForTab(tab) ?? []),
    ),
    promote: null,
    clearAll: false,
  });
  await reconcileContextDeskBootstrap(projectId, restored, tabs);
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
        if (tab.kind !== "tracked" || tab.origin !== "local-untitled") {
          const restored = await restoreServerRoute(
            projectId,
            workingSetRouteForTab(tab) as WorkingSetRoute,
          );
          return restored;
        }
        const workId = isWorkScopedProjectContextScheme(tab.scheme) ? (tab.workId ?? null) : null;
        const result = await fetchContextCatalogView(queryClient, projectId, tab.scheme, workId);
        const file = result.findDocument(tab.documentId);
        if (!file) {
          return {
            tab: null,
            removedRoute: workingSetRouteForTab(tab),
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
      tab.kind === "new" ? [] : (workingSetRouteForTab(tab) ?? []),
    ),
    promote: null,
    clearAll: false,
  });
  await reconcileContextDeskBootstrap(projectId, restored, survivingTabs);
}
