import {
  type CatalogCacheView,
  catalogViewFromCheckpoint,
  sameCatalogProjectionScope,
} from "@meridian/resource-replica";
import { QueryClientContext } from "@tanstack/react-query";
import { useContext, useEffect, useMemo } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  contextCatalogQueryOptions,
  projectResourceCatalogView,
} from "@/client/query/useContextCatalog";
import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";
import {
  useAccountResourceProjection,
  useOptionalAccountResourceReplica,
} from "@/features/project/context/account-feature-context";

export function useReferenceBrowserCatalog(
  projectId: string | null | undefined,
  workId: string | null | undefined,
  label: string,
): AtReferenceCatalog | null {
  const queryClient = useContext(QueryClientContext);
  const resources = useOptionalAccountResourceReplica();
  const projection = useAccountResourceProjection(projectId ?? "");
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
    if (!queryClient || !projectId || !resources) return;
    for (const scope of scopes)
      void queryClient.prefetchQuery(contextCatalogQueryOptions(resources, projectId, scope));
  }, [projectId, queryClient, resources, scopes]);
  return useMemo(
    () =>
      projectId && queryClient && resources
        ? (() => {
            let snapshot = projection.snapshot;
            let projectionError = projection.error;
            const read = (scope: (typeof scopes)[number]) => {
              const checkpoint = snapshot?.catalogs.find(
                (candidate) =>
                  candidate.projectId === projectId &&
                  sameCatalogProjectionScope(candidate.scope, scope),
              );
              const view = checkpoint
                ? catalogViewFromCheckpoint(checkpoint)
                : queryClient.getQueryData<CatalogCacheView>(
                    projectQueryKeys.contextCatalog(projectId, scope),
                  );
              return view
                ? projectResourceCatalogView(projectId, scope, view, snapshot?.records ?? [])
                : null;
            };
            return {
              label,
              openContext: () => ({ warmScopes: scopes }),
              port: {
                subscribe: (listener) => {
                  const stopQuery = queryClient.getQueryCache().subscribe((event) => {
                    const key = event.query.queryKey;
                    if (
                      key[0] === "projects" &&
                      key[1] === projectId &&
                      key[2] === "context-catalog" &&
                      (event.type === "updated" || event.type === "removed")
                    )
                      listener();
                  });
                  const stopProjection = resources.observeProjection(
                    projectId,
                    (next) => {
                      snapshot = next;
                      projectionError = null;
                      listener();
                    },
                    (error) => {
                      projectionError = error;
                      listener();
                    },
                  );
                  return () => {
                    stopQuery();
                    stopProjection();
                  };
                },
                status: (scope) => {
                  const state = queryClient.getQueryState(
                    projectQueryKeys.contextCatalog(projectId, scope),
                  );
                  return read(scope)
                    ? "ready"
                    : projectionError || state?.status === "error"
                      ? "error"
                      : "loading";
                },
                read,
                acquire: async (scope, _signal) => {
                  const view = await queryClient.fetchQuery(
                    contextCatalogQueryOptions(resources, projectId, scope),
                  );
                  snapshot = await resources.readProjection(projectId);
                  return projectResourceCatalogView(projectId, scope, view, snapshot.records);
                },
              },
            };
          })()
        : null,
    [label, projectId, projection.error, projection.snapshot, queryClient, resources, scopes],
  );
}
