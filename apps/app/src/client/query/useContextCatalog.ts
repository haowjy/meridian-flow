/** React Query acquisition and flat selectors over one normalized ID cache. */
import {
  type CatalogScope,
  type CatalogWakeHint,
  catalogScopeKey,
  contextOwner,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import {
  type CatalogCacheView,
  type catalogChildren,
  catalogViewFromCheckpoint,
  emptyCatalogView,
  type FolderNamespaceRecord,
  indexCatalogView,
  projectFolderNeedsRepair,
  projectResourceNeedsRepair,
  type ResourcePlacement,
  type ResourceRecord,
  sameCatalogProjectionScope,
} from "@meridian/resource-replica";
import {
  type QueryClient,
  queryOptions,
  skipToken,
  type UseQueryResult,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { getContextCatalogLookup } from "@/client/api/projects-api";
import { useOptionalThreadTransport } from "@/client/providers/TransportProvider";
import {
  type CatalogContextView,
  type CatalogDirectory,
  type CatalogFile,
  type CatalogNode,
  refusedMoveDestination,
} from "@/client/query/context-catalog-projection";
import { useIsThreadPendingCreation } from "@/client/stores";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import {
  useAccountResourceProjection,
  useOptionalAccountResourceReplica,
} from "@/features/project/context/account-feature-context";
import type { ContextOwner } from "./context-request-options";
import { bumpLinkResolutionEpoch } from "./link-resolution-epoch";
import { projectQueryKeys } from "./project-query-keys";
import { useIsProjectPendingCreation } from "./useProjectCreation";

/** Who a catalog request is for: a Work or lineage holds Scratch, and a chat holds its uploads. */
export type CatalogOwner = {
  workId?: string | null;
  rootThreadId?: string;
  chatId?: string | null;
};

/**
 * The catalog an aggregate view (the link index) reads a scheme from. Scratch
 * reads with the lineage when there is one, else the Work; Uploads read with the
 * chat, and have no catalog where there is none.
 */
export function aggregateCatalogScope(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  owners: {
    workId?: string | null;
    rootThreadId?: string | null;
    chatId?: string | null;
  },
): CatalogScope | null {
  return contextCatalogScope(projectId, scheme, {
    ...contextOwner(owners.workId, owners.rootThreadId),
    chatId: owners.chatId,
  });
}

/** The catalog listing a scheme's documents for this owner; null when its owner is not known. */
export function contextCatalogScope(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  owner: CatalogOwner,
): CatalogScope | null {
  if (scheme === "user") return { kind: "user", userId: "self" };
  if (scheme === "uploads")
    return owner.chatId ? { kind: "chat", projectId, chatId: owner.chatId } : null;
  if (scheme === "scratch" && owner.rootThreadId)
    return { kind: "lineage", projectId, rootThreadId: owner.rootThreadId };
  if (scheme === "scratch") {
    return owner.workId ? { kind: "work", projectId, workId: owner.workId } : null;
  }
  return { kind: "project", projectId };
}

/**
 * The one creation gate for a chat's catalog scopes. Only a lineage or chat scope
 * waits on its chat's creation; other scopes already exist on the server.
 *
 * Hidden constraint: `prefetchQuery` and `fetchQuery` ignore `enabled`, so a
 * gate must remove the scope from the list a reader builds, not just disable
 * its query. Every reader that lists a chat's scopes applies this.
 */
export function catalogScopeReady(
  scope: CatalogScope,
  enabled: boolean,
  pending: { lineage: boolean; chat: boolean },
): boolean {
  return (
    enabled &&
    !((scope.kind === "lineage" && pending.lineage) || (scope.kind === "chat" && pending.chat))
  );
}

export function contextCatalogQueryOptions(
  acquisition: Pick<AccountResourceReplica, "acquireCatalog"> | null,
  projectId: string,
  scope: CatalogScope,
) {
  return queryOptions({
    queryKey: projectQueryKeys.contextCatalog(projectId, scope),
    queryFn: acquisition ? () => acquisition.acquireCatalog(projectId, scope) : skipToken,
    staleTime: 5_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

const ROOT_NAMES: Record<ProjectContextTreeScheme, string> = {
  manuscript: "Manuscript",
  kb: "Knowledge Base",
  user: "User Files",
  unfiled: "Unfiled",
  scratch: "Scratch",
  uploads: "Uploads",
};

/** Project recoverable resource state without treating unrelated account records as project files. */
export function projectResourceCatalogView(
  _projectId: string,
  scope: CatalogScope,
  view: CatalogCacheView,
  records: readonly ResourceRecord[],
  placement: ResourcePlacement,
): CatalogCacheView {
  return indexCatalogView({
    ...view,
    entries: new Map(
      placement
        .projectCatalog([...view.entries.values()], records)
        .filter((entry) => sameCatalogProjectionScope(entry.scope, scope))
        .map((entry) => [entry.entryId, entry]),
    ),
  });
}

/** Project one record whose replica lookup already proved this project's access. */
export function accessibleResourceCatalogView(
  _projectId: string,
  scope: CatalogScope,
  record: ResourceRecord,
  placement: ResourcePlacement,
): CatalogCacheView {
  const view = emptyCatalogView(scope);
  return indexCatalogView({
    ...view,
    entries: new Map(
      placement
        .accessibleResourceCatalog(record)
        .filter((entry) => sameCatalogProjectionScope(entry.scope, scope))
        .map((entry) => [entry.entryId, entry]),
    ),
  });
}

export function projectCatalogFile(
  entry: Extract<ReturnType<typeof catalogChildren>[number], { kind: "file" }>,
): CatalogFile {
  const base = {
    kind: "file" as const,
    entryId: entry.entryId,
    parentId: entry.parentId,
    documentId: entry.entryId,
    name: entry.name,
    aliases: entry.aliases,
    path: `/${entry.path.join("/")}`,
    uri: entry.uri,
    provisionalName: entry.provisionalName,
  };
  if (entry.editable) {
    return {
      ...base,
      editable: true,
      filetype: entry.filetype,
      schemaType: entry.schemaType,
    };
  }
  return {
    ...base,
    editable: false,
    disposition: entry.disposition,
    fileType: entry.fileType,
    ...(entry.disposition === "custom" ? { filetype: entry.filetype } : {}),
    ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
  };
}

function projectCatalogDirectory(
  entry: Extract<ReturnType<typeof catalogChildren>[number], { kind: "folder" }>,
  folder: FolderNamespaceRecord | undefined,
  placement: ResourcePlacement,
): CatalogDirectory {
  const repair = folder ? projectFolderNeedsRepair(folder) : null;
  const failureAt = repair
    ? folder?.intents.find((intent) => intent.intentId === repair.intentId)?.settledAt
    : undefined;
  return {
    kind: "dir",
    entryId: entry.entryId,
    parentId: entry.parentId,
    name: entry.name,
    path: `/${entry.path.join("/")}`,
    uri: entry.uri,
    ...(entry.navigationOnly ? { navigationOnly: true } : {}),
    ...(repair
      ? {
          namespaceFailure: repair.kind,
          namespaceRepairName: repair.name,
          namespaceRepairMove:
            folder && repair.destination
              ? refusedMoveDestination(
                  repair.destination,
                  placement.parentForFolder(folder.folderId),
                )
              : undefined,
          ...(failureAt === undefined ? {} : { namespaceFailureAt: failureAt }),
        }
      : {}),
  };
}

export function projectCatalogView(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  view: CatalogCacheView,
  placement: ResourcePlacement,
  records: readonly ResourceRecord[] = [],
  folders: readonly FolderNamespaceRecord[] = [],
): CatalogContextView {
  const sourceId = view.sourceIdsByScheme.get(scheme);
  const source = sourceId ? view.entries.get(sourceId) : undefined;
  const rootUri = source?.kind === "source" ? source.uri : `${scheme}://`;
  const root: CatalogDirectory = {
    kind: "dir",
    entryId: sourceId ?? `missing:${scheme}`,
    parentId: null,
    name: ROOT_NAMES[scheme],
    path: "/",
    uri: rootUri,
  };
  const resourcesByDocument = new Map(
    records.map((record) => [record.resource.identity.documentId, record]),
  );
  const foldersById = new Map(folders.map((folder) => [folder.folderId, folder]));
  const fileFromEntry = (
    entry: Extract<ReturnType<typeof catalogChildren>[number], { kind: "file" }>,
  ): CatalogFile | null => {
    if (entry.sourceId !== sourceId) return null;
    const record = resourcesByDocument.get(entry.entryId);
    const effective = record ? placement.resourceLocation(record) : null;
    if (
      record &&
      (!effective || effective.scheme !== scheme || effective.path !== `/${entry.path.join("/")}`)
    )
      return null;
    const file = projectCatalogFile(entry);
    const repair = record ? projectResourceNeedsRepair(projectId, record) : null;
    const repairedAt = repair
      ? record?.intents.find((intent) => intent.intentId === repair.intentId)?.settledAt
      : undefined;
    const placementPending = record && placement.resourcePlacementPending(record);
    return record
      ? {
          ...file,
          ...(placementPending ? { placementPending: true as const } : {}),
          ...(record.resource.content.kind === "exact"
            ? {
                resourceHandle: record.resource.handle,
                resourceState:
                  record.resource.lifecycle.kind === "local"
                    ? ("local" as const)
                    : ("acknowledged" as const),
                ...(record.resource.content.initialization === "reserved"
                  ? {}
                  : { localContent: true as const }),
                ...(record.resource.materialization ? { resourceOrigin: "local" as const } : {}),
              }
            : {}),
          ...(repair?.kind === "delete"
            ? { namespaceFailure: "delete" as const }
            : repair
              ? {
                  namespaceFailure: repair.kind,
                  // A nameless create has no name of the writer's to offer back.
                  ...(repair.name ? { namespaceRepairName: repair.name } : {}),
                  namespaceRepairMove: effective
                    ? refusedMoveDestination(
                        repair.destination,
                        placement.parentForResource(record),
                      )
                    : undefined,
                  ...(repairedAt === undefined ? {} : { namespaceFailureAt: repairedAt }),
                }
              : {}),
        }
      : file;
  };
  const node = (entryId: string): CatalogNode | null => {
    const entry = view.entries.get(entryId);
    if (!entry) return null;
    if (entry.kind === "file") return fileFromEntry(entry);
    if (entry.kind === "folder" && entry.sourceId === sourceId)
      return projectCatalogDirectory(entry, foldersById.get(entry.entryId), placement);
    return null;
  };
  const files = () =>
    [...view.entries.values()].flatMap((entry) =>
      entry.kind === "file"
        ? (() => {
            const file = fileFromEntry(entry);
            return file ? [file] : [];
          })()
        : [],
    );
  const base: CatalogContextView = {
    normalized: view,
    root,
    children: (parentId) =>
      (view.childIdsByParentId.get(parentId) ?? []).flatMap((entryId) => {
        const child = node(entryId);
        return child ? [child] : [];
      }),
    files,
    findPath: (path) =>
      files().find((file) => file.path === path) ??
      [...view.entries.values()].flatMap((entry) =>
        entry.kind === "folder" &&
        entry.sourceId === sourceId &&
        `/${entry.path.join("/")}` === path
          ? [projectCatalogDirectory(entry, foldersById.get(entry.entryId), placement)]
          : [],
      )[0] ??
      null,
    findDocument: (documentId) => {
      const found = node(documentId);
      return found?.kind === "file" ? found : null;
    },
  };
  return base;
}

export async function lookupContextCatalogFile(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  owner: CatalogOwner,
  lookup: { entryId: string } | { uri: string },
) {
  const scope = contextCatalogScope(projectId, scheme, owner);
  if (!scope) return null;
  const result = await getContextCatalogLookup(projectId, scope, lookup);
  return result.entry?.kind === "file" && result.entry.uri.startsWith(`${scheme}://`)
    ? projectCatalogFile(result.entry)
    : null;
}

export function useContextCatalogView(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  options: { enabled?: boolean } & ContextOwner,
) {
  const schemes = useMemo(() => [scheme], [scheme]);
  return useContextCatalogViews(projectId, schemes, options)[scheme];
}

type CatalogViewResult = {
  catalog: CatalogContextView | null;
  /** Optimistic rows alone cannot prove absence or uniqueness. */
  isComplete: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

/** Composite consumers share one observation and one query per distinct authority scope. */
export function useContextCatalogViews<S extends ProjectContextTreeScheme>(
  projectId: string,
  schemes: readonly S[],
  options: {
    enabled?: boolean;
  } & CatalogOwner,
): Record<S, CatalogViewResult> {
  const projectPending = useIsProjectPendingCreation(projectId);
  const { workId, rootThreadId, chatId } = options;
  // A first send's chat is not on the server yet; its lineage and chat scopes would answer 404.
  const pending = {
    lineage: useIsThreadPendingCreation(rootThreadId),
    chat: useIsThreadPendingCreation(chatId),
  };
  const enabled = (options.enabled ?? true) && !projectPending;
  const scopeFor = useCallback(
    (scheme: ProjectContextTreeScheme) =>
      aggregateCatalogScope(projectId, scheme, { workId, rootThreadId, chatId }),
    [projectId, workId, rootThreadId, chatId],
  );
  const scopes = useMemo(() => {
    const result: CatalogScope[] = [];
    for (const scheme of schemes) {
      const scope = scopeFor(scheme);
      if (scope && !result.some((existing) => sameCatalogProjectionScope(existing, scope)))
        result.push(scope);
    }
    return result;
  }, [schemes, scopeFor]);
  const resources = useOptionalAccountResourceReplica();
  const { records, folders, snapshot, placement, error } = useAccountResourceProjection(projectId);
  const combine = useCallback(
    (queries: UseQueryResult<CatalogCacheView>[]) => {
      const results = {} as Record<S, CatalogViewResult>;
      scopes.forEach((scope, index) => {
        const query = queries[index];
        const checkpoint = snapshot?.catalogs.find(
          (candidate) =>
            candidate.projectId === projectId && sameCatalogProjectionScope(candidate.scope, scope),
        );
        const view = resources
          ? checkpoint
            ? catalogViewFromCheckpoint(checkpoint)
            : (query.data ??
              (records.length > 0 || folders.some((folder) => projectFolderNeedsRepair(folder))
                ? emptyCatalogView(scope)
                : null))
          : query.data;
        const projected = view
          ? projectResourceCatalogView(projectId, scope, view, records, placement)
          : null;
        for (const scheme of schemes) {
          const requested = scopeFor(scheme);
          if (!requested || !sameCatalogProjectionScope(requested, scope)) continue;
          results[scheme] = {
            catalog: projected
              ? projectCatalogView(projectId, scheme, projected, placement, records, folders)
              : null,
            isComplete: resources ? Boolean(checkpoint) : Boolean(query.data),
            isError: query.isError || error !== null,
            isFetching: query.isFetching,
            refetch: query.refetch,
          };
        }
      });
      for (const scheme of schemes) {
        if (results[scheme]) continue;
        results[scheme] = {
          catalog: null,
          isComplete: false,
          isError: false,
          isFetching: false,
          refetch: () => undefined,
        };
      }
      return results;
    },
    [projectId, schemes, scopeFor, scopes, resources, records, folders, snapshot, placement, error],
  );
  return useQueries({
    queries: scopes.map((scope) => ({
      ...contextCatalogQueryOptions(resources, projectId, scope),
      enabled: catalogScopeReady(scope, enabled, pending),
    })),
    combine,
  });
}

export function useContextCatalogScope(projectId: string, scope: CatalogScope, enabled = true) {
  const projectPending = useIsProjectPendingCreation(projectId);
  const pending = {
    lineage: useIsThreadPendingCreation(scope.kind === "lineage" ? scope.rootThreadId : null),
    chat: useIsThreadPendingCreation(scope.kind === "chat" ? scope.chatId : null),
  };
  const scopeKind = scope.kind;
  const scopeProjectId = scope.kind === "user" ? undefined : scope.projectId;
  const scopeUserId = scope.kind === "user" ? scope.userId : undefined;
  const scopeWorkId = scope.kind === "work" ? scope.workId : undefined;
  const scopeRootThreadId = scope.kind === "lineage" ? scope.rootThreadId : undefined;
  const scopeChatId = scope.kind === "chat" ? scope.chatId : undefined;
  const stableScope = useMemo<CatalogScope>(
    () =>
      scopeKind === "user"
        ? { kind: "user", userId: scopeUserId as string }
        : scopeKind === "work"
          ? {
              kind: "work",
              projectId: scopeProjectId as string,
              workId: scopeWorkId as string,
            }
          : scopeKind === "lineage"
            ? {
                kind: "lineage",
                projectId: scopeProjectId as string,
                rootThreadId: scopeRootThreadId as string,
              }
            : scopeKind === "chat"
              ? {
                  kind: "chat",
                  projectId: scopeProjectId as string,
                  chatId: scopeChatId as string,
                }
              : { kind: "project", projectId: scopeProjectId as string },
    [scopeKind, scopeProjectId, scopeUserId, scopeWorkId, scopeRootThreadId, scopeChatId],
  );
  const resources = useOptionalAccountResourceReplica();
  const projection = useAccountResourceProjection(projectId);
  const query = useQuery({
    ...contextCatalogQueryOptions(resources, projectId, stableScope),
    enabled: catalogScopeReady(stableScope, enabled && !projectPending, pending),
  });
  const data = useMemo(() => {
    const checkpoint = projection.snapshot?.catalogs.find(
      (candidate) =>
        candidate.projectId === projectId &&
        sameCatalogProjectionScope(candidate.scope, stableScope),
    );
    const view = checkpoint
      ? catalogViewFromCheckpoint(checkpoint)
      : (query.data ??
        (projection.folders.some((folder) => projectFolderNeedsRepair(folder))
          ? emptyCatalogView(stableScope)
          : undefined));
    return view
      ? projectResourceCatalogView(
          projectId,
          stableScope,
          view,
          projection.records,
          projection.placement,
        )
      : undefined;
  }, [
    projectId,
    projection.records,
    projection.placement,
    projection.snapshot,
    query.data,
    stableScope,
  ]);
  return {
    ...query,
    data,
    error: projection.error ?? query.error,
    isError: query.isError || projection.error !== null,
  };
}

/** Own the project's single live wake subscription above every catalog consumer. */
export function useContextCatalogWake(
  projectId: string,
  onColdWorkHint?: (workId: string) => void,
): void {
  const queryClient = useQueryClient();
  const resources = useOptionalAccountResourceReplica();
  const transport = useOptionalThreadTransport();
  // A create that joined a branch's new document now is that document, so its draft list is
  // stale: the writer sees the draft's review at once, not at the next reload or hint.
  useEffect(
    () =>
      projectId
        ? resources?.onIdentityChanged((change) => {
            if (change.projectId === projectId) invalidateDraftReads(queryClient, projectId);
          })
        : undefined,
    [projectId, queryClient, resources],
  );
  useEffect(
    () =>
      projectId
        ? transport?.subscribeCatalog(projectId, (hint) => {
            bumpLinkResolutionEpoch(projectId);
            void queryClient.invalidateQueries({
              queryKey: projectQueryKeys.documentTrash(projectId),
            });
            const requestedScope: CatalogScope =
              hint.scope.kind === "user" ? { kind: "user", userId: "self" } : hint.scope;
            const mounted =
              queryClient
                .getQueryCache()
                .find({
                  queryKey: projectQueryKeys.contextCatalog(projectId, requestedScope),
                  exact: true,
                })
                ?.getObserversCount() ?? 0;
            if (mounted === 0 && requestedScope.kind === "work") {
              onColdWorkHint?.(requestedScope.workId);
            }
            if (resources) pullContextCatalogOnHint(queryClient, resources, projectId, hint);
          })
        : undefined,
    [onColdWorkHint, projectId, queryClient, resources, transport],
  );
}

/** Every draft read of the project: each Work's list and each document's hints. */
function invalidateDraftReads(queryClient: QueryClient, projectId: string): void {
  void queryClient.invalidateQueries(allWorkDraftListsOf(projectId));
  void queryClient.invalidateQueries({
    queryKey: projectQueryKeys.documentDraftHintsOf(projectId),
  });
}

/** Every mounted draft list of the project, whatever Work it belongs to. */
function allWorkDraftListsOf(projectId: string) {
  return {
    predicate: ({ queryKey }: { queryKey: readonly unknown[] }) =>
      queryKey[0] === "projects" &&
      queryKey[1] === projectId &&
      queryKey[2] === "works" &&
      queryKey[4] === "branches",
  };
}

/** The newest installed catalog revision each scope's hints have already re-read draft lists for. */
const refreshedRevisions = new WeakMap<QueryClient, Map<string, bigint>>();

/** Whether `applied` is a revision this scope's draft lists were not yet re-read for; records it when so. */
function advancesDraftRefresh(
  queryClient: QueryClient,
  scope: CatalogScope,
  applied: string,
): boolean {
  if (!/^\d+$/.test(applied)) return true;
  const revision = BigInt(applied);
  const refreshed = refreshedRevisions.get(queryClient) ?? new Map<string, bigint>();
  refreshedRevisions.set(queryClient, refreshed);
  const key = catalogScopeKey(scope);
  const last = refreshed.get(key);
  if (last !== undefined && revision <= last) return false;
  refreshed.set(key, revision);
  return true;
}

/**
 * Duplicate-tolerant wake hint handler; the hint never mutates cache state itself.
 *
 * A manifest change is also the one signal another page's Apply or Discard sends: a draft-only
 * document joins or never joins the manifest, and nothing else tells this page its Work's draft
 * list is out of date. Mounted draft lists re-read, which is what ends a review and settles a
 * draft-only tab whose draft was disposed elsewhere. A Work-scoped hint names its Work, so only
 * that Work's list re-reads; a project-wide hint cannot, so every list of the project does. A hint
 * that installs no revision newer than the last one handled re-reads nothing, and a user-scoped
 * catalog holds no project branches.
 */
export function pullContextCatalogOnHint(
  queryClient: QueryClient,
  resources: Pick<AccountResourceReplica, "hintCatalog">,
  projectId: string,
  hint: CatalogWakeHint,
): void {
  const requestedScope: CatalogScope =
    hint.scope.kind === "user" ? { kind: "user", userId: "self" } : hint.scope;
  void resources
    .hintCatalog(projectId, requestedScope, hint.headRevision)
    .then((next) => {
      queryClient.setQueryData(projectQueryKeys.contextCatalog(projectId, requestedScope), next);
      if (requestedScope.kind === "user") return;
      if (!advancesDraftRefresh(queryClient, requestedScope, next.appliedRevision)) return;
      void queryClient.invalidateQueries(
        requestedScope.kind === "work"
          ? { queryKey: projectQueryKeys.workBranchDrafts(projectId, requestedScope.workId) }
          : allWorkDraftListsOf(projectId),
      );
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.documentDraftHintsOf(projectId),
      });
    })
    .catch(() => undefined);
}
