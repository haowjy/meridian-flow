import { QueryClientContext } from "@tanstack/react-query";
import { useContext, useEffect, useMemo } from "react";
import type { CatalogCacheView } from "@/client/query/context-catalog-cache";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { contextCatalogQueryOptions } from "@/client/query/useContextCatalog";
import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";

export function useReferenceBrowserCatalog(
  projectId: string | null | undefined,
  workId: string | null | undefined,
  label: string,
): AtReferenceCatalog | null {
  const queryClient = useContext(QueryClientContext);
  const scopes = useMemo(
    () =>
      projectId
        ? [
            { kind: "project" as const, projectId },
            { kind: "user" as const, userId: "self" },
            workId
              ? { kind: "work" as const, projectId, workId }
              : { kind: "none" as const, projectId },
          ]
        : [],
    [projectId, workId],
  );
  useEffect(() => {
    if (!queryClient || !projectId) return;
    for (const scope of scopes)
      void queryClient.prefetchQuery(contextCatalogQueryOptions(queryClient, projectId, scope));
  }, [projectId, queryClient, scopes]);
  return useMemo(
    () =>
      projectId && queryClient
        ? {
            label,
            openContext: () => ({ warmScopes: scopes }),
            port: {
              subscribe: (listener) =>
                queryClient.getQueryCache().subscribe((event) => {
                  const key = event.query.queryKey;
                  if (
                    key[0] === "projects" &&
                    key[1] === projectId &&
                    key[2] === "context-catalog" &&
                    (event.type === "updated" || event.type === "removed")
                  )
                    listener();
                }),
              status: (scope) => {
                const state = queryClient.getQueryState(
                  projectQueryKeys.contextCatalog(projectId, scope),
                );
                return state?.status === "error" ? "error" : state?.data ? "ready" : "loading";
              },
              read: (scope) =>
                queryClient.getQueryData<CatalogCacheView>(
                  projectQueryKeys.contextCatalog(projectId, scope),
                ) ?? null,
              acquire: (scope, _signal) =>
                queryClient.fetchQuery(contextCatalogQueryOptions(queryClient, projectId, scope)),
            },
          }
        : null,
    [label, projectId, queryClient, scopes],
  );
}
