/** React Query acquisition and flat selectors over one normalized ID cache. */
import { canonicalContextUri } from "@meridian/contracts/context-uri";
import {
  type CatalogFileEntry,
  type CatalogScope,
  type CatalogWakeHint,
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import {
  type CatalogCacheView,
  type catalogChildren,
  catalogViewFromCheckpoint,
  catalogViewFromSnapshot,
  emptyCatalogView,
  indexCatalogView,
  projectResourceLocation,
  projectResourceNeedsRepair,
  type ResourceRecord,
  sameCatalogProjectionScope,
} from "@meridian/resource-replica";
import {
  type QueryClient,
  queryOptions,
  skipToken,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { getContextCatalogLookup } from "@/client/api/projects-api";
import { useOptionalThreadTransport } from "@/client/providers/TransportProvider";
import type {
  CatalogContextView,
  CatalogDirectory,
  CatalogFile,
  CatalogNode,
} from "@/client/query/context-catalog-projection";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import {
  useAccountResourceProjection,
  useOptionalAccountResourceReplica,
} from "@/features/project/context/account-feature-context";
import { projectQueryKeys } from "./project-query-keys";

export function contextCatalogScope(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  workId: string | null,
): CatalogScope {
  if (scheme === "user") return { kind: "user", userId: "self" };
  if (scheme === "scratch" || scheme === "uploads") {
    return workId ? { kind: "work", projectId, workId } : { kind: "none", projectId };
  }
  return { kind: "project", projectId };
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
    refetchOnMount: "always",
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

function locationBelongsToScope(
  location: ReturnType<typeof projectResourceLocation> & {},
  scope: CatalogScope,
): boolean {
  if (scope.kind === "project")
    return !isWorkScopedProjectContextScheme(location.scheme) && location.scheme !== "user";
  if (scope.kind === "user") return location.scheme === "user";
  if (!isWorkScopedProjectContextScheme(location.scheme)) return false;
  return scope.kind === "work" ? location.workId === scope.workId : location.workId === null;
}

function catalogUri(scheme: ProjectContextTreeScheme, path: string, scope: CatalogScope): string {
  return isWorkScopedProjectContextScheme(scheme)
    ? canonicalContextUri(
        scheme,
        path,
        scope.kind === "none" ? { kind: "none" } : { kind: "contextual" },
      )
    : canonicalContextUri(scheme, path);
}

/** One normalized catalog read model: durable local intentions overlay the server checkpoint. */
function overlayResourceCatalogView(
  projectId: string,
  scope: CatalogScope,
  view: CatalogCacheView,
  records: readonly ResourceRecord[],
  isKnownVisible: (record: ResourceRecord) => boolean,
): CatalogCacheView {
  const entries = new Map(view.entries);
  const invalidatedEntryIds = new Set(view.invalidatedEntryIds);
  for (const record of records) {
    const documentId = record.resource.identity.documentId;
    const location = projectResourceLocation(projectId, record);
    const visible =
      isKnownVisible(record) ||
      record.intents.some(
        (intent) => intent.projectId === projectId && intent.state !== "cancelled",
      ) ||
      location?.scheme === "user" ||
      (entries.has(documentId) && !invalidatedEntryIds.has(documentId));
    if (!visible) continue;
    const installed = entries.get(documentId);
    const installedMatches =
      installed?.kind === "file" &&
      installed.uri.startsWith(`${location?.scheme}://`) &&
      `/${installed.path.join("/")}` === location?.path;
    if (installed && !installedMatches) entries.delete(documentId);
    if (!location || !locationBelongsToScope(location, scope) || installedMatches) continue;

    const sourceId =
      [...entries.values()].find(
        (entry) =>
          entry.kind === "source" &&
          entry.scheme === location.scheme &&
          !invalidatedEntryIds.has(entry.entryId),
      )?.entryId ?? `local-source:${location.scheme}:${JSON.stringify(scope)}`;
    if (!entries.has(sourceId)) {
      entries.set(sourceId, {
        kind: "source",
        entryId: sourceId,
        scope,
        scheme: location.scheme,
        name: ROOT_NAMES[location.scheme],
        uri: catalogUri(location.scheme, "", scope),
      });
    }
    invalidatedEntryIds.delete(sourceId);
    const path = location.path.split("/").filter(Boolean);
    let parentId = sourceId;
    for (let depth = 1; depth < path.length; depth += 1) {
      const folderPath = path.slice(0, depth);
      const existing = [...entries.values()].find(
        (entry) =>
          entry.kind === "folder" &&
          entry.sourceId === sourceId &&
          entry.path.join("/") === folderPath.join("/") &&
          !invalidatedEntryIds.has(entry.entryId),
      );
      if (existing?.kind === "folder") {
        parentId = existing.entryId;
        continue;
      }
      const folderId = `local-folder:${sourceId}:${folderPath.join("/")}`;
      entries.set(folderId, {
        kind: "folder",
        entryId: folderId,
        scope,
        sourceId,
        parentId,
        name: folderPath.at(-1) ?? "",
        path: folderPath,
        uri: catalogUri(location.scheme, folderPath.join("/"), scope),
        hasChildren: true,
      });
      invalidatedEntryIds.delete(folderId);
      parentId = folderId;
    }
    const uri = catalogUri(location.scheme, path.join("/"), scope);
    entries.set(documentId, {
      kind: "file",
      entryId: documentId,
      scope,
      sourceId,
      parentId,
      aliases: [],
      name: location.name,
      path,
      uri,
      provisionalName: location.provisional,
      ...record.resource.classification,
    } satisfies CatalogFileEntry);
    invalidatedEntryIds.delete(documentId);
  }
  return indexCatalogView({ ...view, entries, invalidatedEntryIds });
}

/** Overlay recoverable resource state without treating unrelated account records as project files. */
export function projectResourceCatalogView(
  projectId: string,
  scope: CatalogScope,
  view: CatalogCacheView,
  records: readonly ResourceRecord[],
): CatalogCacheView {
  return overlayResourceCatalogView(projectId, scope, view, records, () => false);
}

/** Project one record whose replica lookup already proved this project's access. */
export function accessibleResourceCatalogView(
  projectId: string,
  scope: CatalogScope,
  record: ResourceRecord,
): CatalogCacheView {
  return overlayResourceCatalogView(
    projectId,
    scope,
    emptyCatalogView(scope),
    [record],
    () => true,
  );
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
): CatalogDirectory {
  return {
    kind: "dir",
    entryId: entry.entryId,
    parentId: entry.parentId,
    name: entry.name,
    path: `/${entry.path.join("/")}`,
    uri: entry.uri,
  };
}

export function projectCatalogView(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  view: CatalogCacheView,
  records: readonly ResourceRecord[] = [],
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
  const fileFromEntry = (
    entry: Extract<ReturnType<typeof catalogChildren>[number], { kind: "file" }>,
  ): CatalogFile | null => {
    if (entry.sourceId !== sourceId) return null;
    const record = resourcesByDocument.get(entry.entryId);
    const effective = record ? projectResourceLocation(projectId, record) : null;
    if (
      record &&
      (!effective || effective.scheme !== scheme || effective.path !== `/${entry.path.join("/")}`)
    )
      return null;
    const file = projectCatalogFile(entry);
    const repair = record ? projectResourceNeedsRepair(projectId, record) : null;
    return record
      ? {
          ...file,
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
                ...(record.intents.some((intent) => intent.desired.kind === "create")
                  ? { resourceOrigin: "local" as const }
                  : {}),
              }
            : {}),
          ...(repair?.kind === "delete"
            ? { namespaceFailure: "delete" as const }
            : repair?.kind === "set-location"
              ? { namespaceFailure: "set-location" as const, namespaceRepairName: repair.name }
              : {}),
        }
      : file;
  };
  const node = (entryId: string): CatalogNode | null => {
    const entry = view.entries.get(entryId);
    if (!entry || view.invalidatedEntryIds.has(entryId)) return null;
    if (entry.kind === "file") return fileFromEntry(entry);
    if (entry.kind === "folder" && entry.sourceId === sourceId)
      return projectCatalogDirectory(entry);
    return null;
  };
  const files = () =>
    [...view.entries.values()].flatMap((entry) =>
      entry.kind === "file" && !view.invalidatedEntryIds.has(entry.entryId)
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
        !view.invalidatedEntryIds.has(entry.entryId) &&
        `/${entry.path.join("/")}` === path
          ? [projectCatalogDirectory(entry)]
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
  workId: string | null,
  lookup: { entryId: string } | { uri: string },
) {
  const result = await getContextCatalogLookup(
    projectId,
    contextCatalogScope(projectId, scheme, workId),
    lookup,
  );
  return result.entry?.kind === "file" && result.entry.uri.startsWith(`${scheme}://`)
    ? projectCatalogFile(result.entry)
    : null;
}

export function useContextCatalogView(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  options: { enabled?: boolean; workId: string | null },
) {
  const scope = useMemo(
    () => contextCatalogScope(projectId, scheme, options.workId),
    [options.workId, projectId, scheme],
  );
  const resources = useOptionalAccountResourceReplica();
  const resourceProjection = useAccountResourceProjection(projectId);
  const query = useQuery({
    ...contextCatalogQueryOptions(resources, projectId, scope),
    enabled: options.enabled ?? true,
  });
  const response = useMemo(() => {
    const checkpoint = resourceProjection.snapshot?.catalogs.find(
      (candidate) =>
        candidate.projectId === projectId && sameCatalogProjectionScope(candidate.scope, scope),
    );
    const view = resources
      ? checkpoint
        ? catalogViewFromCheckpoint(checkpoint)
        : query.data
          ? query.data
          : resourceProjection.records.length > 0
            ? catalogViewFromSnapshot({
                scope,
                generation: "local",
                headRevision: "0",
                cursor: "",
                entries: [],
              })
            : null
      : query.data;
    return {
      catalog: view
        ? projectCatalogView(
            projectId,
            scheme,
            projectResourceCatalogView(projectId, scope, view, resourceProjection.records),
            resourceProjection.records,
          )
        : null,
      complete: resources ? Boolean(checkpoint) : Boolean(query.data),
    };
  }, [
    projectId,
    query.data,
    resourceProjection.records,
    resourceProjection.snapshot,
    resources,
    scheme,
    scope,
  ]);
  return {
    catalog: response.catalog,
    /** A durable/server catalog exists; optimistic rows alone cannot prove absence or uniqueness. */
    isComplete: response.complete,
    isError: query.isError || resourceProjection.error !== null,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}

export function useContextCatalogScope(projectId: string, scope: CatalogScope, enabled = true) {
  const scopeKind = scope.kind;
  const scopeProjectId = scope.kind === "user" ? undefined : scope.projectId;
  const scopeUserId = scope.kind === "user" ? scope.userId : undefined;
  const scopeWorkId = scope.kind === "work" ? scope.workId : undefined;
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
          : { kind: scopeKind, projectId: scopeProjectId as string },
    [scopeKind, scopeProjectId, scopeUserId, scopeWorkId],
  );
  const resources = useOptionalAccountResourceReplica();
  const projection = useAccountResourceProjection(projectId);
  const query = useQuery({
    ...contextCatalogQueryOptions(resources, projectId, stableScope),
    enabled,
  });
  const data = useMemo(() => {
    const checkpoint = projection.snapshot?.catalogs.find(
      (candidate) =>
        candidate.projectId === projectId &&
        sameCatalogProjectionScope(candidate.scope, stableScope),
    );
    const view = checkpoint ? catalogViewFromCheckpoint(checkpoint) : query.data;
    return view
      ? projectResourceCatalogView(projectId, stableScope, view, projection.records)
      : undefined;
  }, [projectId, projection.records, projection.snapshot, query.data, stableScope]);
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
  useEffect(
    () =>
      projectId
        ? transport?.subscribeCatalog(projectId, (hint) => {
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

/** Duplicate-tolerant wake hint handler; the hint never mutates cache state itself. */
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
    .then((next) =>
      queryClient.setQueryData(projectQueryKeys.contextCatalog(projectId, requestedScope), next),
    )
    .catch(() => undefined);
}
