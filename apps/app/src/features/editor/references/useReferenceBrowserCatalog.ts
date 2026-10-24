import type { CatalogScope } from "@meridian/contracts/protocol";
import {
  type CatalogCacheView,
  catalogViewFromCheckpoint,
  resourcePlacementForSnapshot,
  sameCatalogProjectionScope,
} from "@meridian/resource-replica";
import { QueryClientContext } from "@tanstack/react-query";
import { useContext, useMemo } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  catalogScopeReady,
  contextCatalogQueryOptions,
  projectResourceCatalogView,
} from "@/client/query/useContextCatalog";
import { useIsProjectPendingCreation } from "@/client/query/useProjectCreation";
import { useIsThreadPendingCreation } from "@/client/stores";
import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";
import {
  useAccountResourceProjection,
  useOptionalAccountResourceReplica,
} from "@/features/project/context/account-feature-context";

export function useReferenceBrowserCatalog(
  projectId: string | null | undefined,
  workId: string | null | undefined,
  label: string,
  /** A No Work chat's lineage: its Scratch joins the Work's in the catalog. */
  rootThreadId?: string | null,
  /** The chat whose uploads the picker offers: a subagent's top chat. */
  chatId?: string | null,
): AtReferenceCatalog | null {
  const queryClient = useContext(QueryClientContext);
  const resources = useOptionalAccountResourceReplica();
  const projection = useAccountResourceProjection(projectId ?? "");
  const projectPending = useIsProjectPendingCreation(projectId);
  const lineagePending = useIsThreadPendingCreation(rootThreadId);
  const chatPending = useIsThreadPendingCreation(chatId);
  const scopes = useMemo(
    () =>
      projectId
        ? [
            { kind: "project" as const, projectId },
            { kind: "user" as const, userId: "self" },
            ...(workId ? [{ kind: "work" as const, projectId, workId }] : []),
            ...(rootThreadId ? [{ kind: "lineage" as const, projectId, rootThreadId }] : []),
            ...(chatId ? [{ kind: "chat" as const, projectId, chatId }] : []),
          ].filter((scope) =>
            catalogScopeReady(scope, true, { lineage: lineagePending, chat: chatPending }),
          )
        : [],
    [projectId, workId, rootThreadId, chatId, lineagePending, chatPending],
  );
  return useMemo(
    () =>
      projectId && queryClient && resources && !projectPending
        ? (() => {
            let snapshot = projection.snapshot;
            let projectionError = projection.error;
            const read = (scope: CatalogScope) => {
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
                ? projectResourceCatalogView(
                    projectId,
                    scope,
                    view,
                    snapshot?.records ?? [],
                    snapshot
                      ? resourcePlacementForSnapshot(projectId, snapshot)
                      : projection.placement,
                  )
                : null;
            };
            return {
              label,
              openContext: () => {
                for (const scope of scopes)
                  void queryClient.prefetchQuery(
                    contextCatalogQueryOptions(resources, projectId, scope),
                  );
                return { warmScopes: scopes };
              },
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
                  return projectResourceCatalogView(
                    projectId,
                    scope,
                    view,
                    snapshot.records,
                    resourcePlacementForSnapshot(projectId, snapshot),
                  );
                },
              },
            };
          })()
        : null,
    [
      label,
      projectId,
      projectPending,
      projection.error,
      projection.snapshot,
      projection.placement,
      queryClient,
      resources,
      scopes,
    ],
  );
}
