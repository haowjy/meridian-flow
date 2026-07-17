/** Re-materializes hydrated working-set routes as inactive, tree-validated tabs. */

import {
  isWorkScopedProjectContextScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import { projectContextTreeQueryOptions } from "@/client/query/useProjectContextTree";
import { useContextTabsStore } from "@/client/stores";
import { readRecentRoutes, workingSetRouteEquals } from "@/client/working-set";
import { contextTabFromFile } from "./context/context-tab-from-file";
import { findContextFile } from "./context/context-tree";

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
  await Promise.allSettled(
    routes.map(async (route) => {
      const workScoped = isWorkScopedProjectContextScheme(route.scheme);
      if (workScoped && route.workId !== routeWorkId) return;
      const workId: string | null = workScoped ? (route.workId ?? null) : null;
      const result = await queryClient.fetchQuery(
        projectContextTreeQueryOptions(projectId, route.scheme, workId),
      );
      const file = findContextFile(result.tree, route.path);
      if (!file || !isWorkingSetRouteDesired(route, readRecentRoutes(projectId))) return;
      useContextTabsStore
        .getState()
        .openTab(projectId, contextTabFromFile(route.scheme, file, workId));
    }),
  );
}
