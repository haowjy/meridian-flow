import type {
  CatalogAuthorityEntry,
  CatalogFileEntry,
  CatalogFolderEntry,
  CatalogScope,
} from "@meridian/contracts/protocol";
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
import {
  referenceAuthorityIndex,
  referenceRowForFile,
  referenceRowForFolder,
} from "@/core/completion/reference-policy";
import type { ReferenceBrowserCatalog } from "@/core/editor/extensions/at-reference";
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
): ReferenceBrowserCatalog | null {
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
            let referenceIndex: Map<
              string,
              NonNullable<ReturnType<ReferenceBrowserCatalog["resolveReference"]>>
            > | null = null;
            const buildReferenceIndex = () => {
              const authorities: CatalogAuthorityEntry[] = [];
              const files: CatalogFileEntry[] = [];
              const folders: CatalogFolderEntry[] = [];
              for (const scope of scopes) {
                const view = read(scope);
                if (!view) continue;
                for (const entry of view.entries.values()) {
                  if (entry.kind === "authority") authorities.push(entry);
                  else if (entry.kind === "file") files.push(entry);
                  else if (entry.kind === "folder") folders.push(entry);
                }
              }
              const authorityIndex = referenceAuthorityIndex(authorities);
              const next = new Map<
                string,
                NonNullable<ReturnType<ReferenceBrowserCatalog["resolveReference"]>>
              >();
              for (const entry of files) {
                const row = referenceRowForFile(entry, authorityIndex);
                if (row) next.set(`file:${entry.entryId}`, row);
              }
              for (const entry of folders) {
                const row = referenceRowForFolder(entry, authorityIndex);
                if (row) next.set(`folder:${entry.entryId}`, row);
              }
              return next;
            };
            const resolveReference: ReferenceBrowserCatalog["resolveReference"] = (reference) => {
              referenceIndex ??= buildReferenceIndex();
              return referenceIndex.get(`${reference.kind}:${reference.id}`) ?? null;
            };
            return {
              label,
              resolveReference,
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
                    ) {
                      referenceIndex = null;
                      listener();
                    }
                  });
                  const stopProjection = resources.observeProjection(
                    projectId,
                    (next) => {
                      snapshot = next;
                      projectionError = null;
                      referenceIndex = null;
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
