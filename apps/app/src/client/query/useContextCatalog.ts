/** React Query acquisition and flat selectors over one normalized ID cache. */
import type {
  CatalogScope,
  CatalogWakeHint,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { getContextCatalogLookup } from "@/client/api/projects-api";
import { useOptionalThreadTransport } from "@/client/providers/TransportProvider";
import type {
  CatalogContextView,
  CatalogDirectory,
  CatalogFile,
  CatalogNode,
} from "@/client/query/context-catalog-projection";
import { acquireContextCatalog, hintContextCatalog } from "./context-catalog-acquisition";
import type { CatalogCacheView, catalogChildren } from "./context-catalog-cache";
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
  queryClient: QueryClient,
  projectId: string,
  scope: CatalogScope,
) {
  return queryOptions({
    queryKey: projectQueryKeys.contextCatalog(projectId, scope),
    queryFn: () =>
      acquireContextCatalog(
        queryClient,
        projectQueryKeys.contextCatalog(projectId, scope),
        projectId,
        scope,
      ),
    staleTime: 5_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

const ROOT_NAMES: Record<ProjectContextTreeScheme, string> = {
  manuscript: "Manuscript",
  kb: "Knowledge Base",
  user: "User Files",
  scratch: "Scratch",
  uploads: "Uploads",
};

export function projectCatalogFile(
  entry: Extract<ReturnType<typeof catalogChildren>[number], { kind: "file" }>,
): CatalogFile {
  const base = {
    kind: "file" as const,
    entryId: entry.entryId,
    parentId: entry.parentId,
    documentId: entry.entryId,
    name: entry.name,
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
  const node = (entryId: string): CatalogNode | null => {
    const entry = view.entries.get(entryId);
    if (!entry || view.invalidatedEntryIds.has(entryId)) return null;
    if (entry.kind === "file") return projectCatalogFile(entry);
    if (entry.kind === "folder") return projectCatalogDirectory(entry);
    return null;
  };
  const files = () =>
    [...view.entries.values()].flatMap((entry) =>
      entry.kind === "file" && !view.invalidatedEntryIds.has(entry.entryId)
        ? [projectCatalogFile(entry)]
        : [],
    );
  return {
    projectId,
    scheme,
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
        entry.kind === "folder" && `/${entry.path.join("/")}` === path
          ? [projectCatalogDirectory(entry)]
          : [],
      )[0] ??
      null,
    findDocument: (documentId) => {
      const found = node(documentId);
      return found?.kind === "file" ? found : null;
    },
  };
}

export async function fetchContextCatalogView(
  queryClient: QueryClient,
  projectId: string,
  scheme: ProjectContextTreeScheme,
  workId: string | null,
): Promise<CatalogContextView> {
  const scope = contextCatalogScope(projectId, scheme, workId);
  const view = await queryClient.fetchQuery(
    contextCatalogQueryOptions(queryClient, projectId, scope),
  );
  return projectCatalogView(projectId, scheme, view);
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
  const scope = contextCatalogScope(projectId, scheme, options.workId);
  const queryClient = useQueryClient();
  const query = useQuery({
    ...contextCatalogQueryOptions(queryClient, projectId, scope),
    enabled: options.enabled ?? true,
  });
  const response = useMemo(
    () => (query.data ? projectCatalogView(projectId, scheme, query.data) : null),
    [projectId, query.data, scheme],
  );
  return {
    catalog: response,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}

export function useContextCatalogScope(projectId: string, scope: CatalogScope, enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({ ...contextCatalogQueryOptions(queryClient, projectId, scope), enabled });
}

/** Own the project's single live wake subscription above every catalog consumer. */
export function useContextCatalogWake(
  projectId: string,
  onColdWorkHint?: (workId: string) => void,
): void {
  const queryClient = useQueryClient();
  const transport = useOptionalThreadTransport();
  useEffect(
    () =>
      projectId
        ? transport?.subscribeCatalog(projectId, (hint) => {
            const requestedScope: CatalogScope =
              hint.scope.kind === "user" ? { kind: "user", userId: "self" } : hint.scope;
            const installed = queryClient.getQueryData(
              projectQueryKeys.contextCatalog(projectId, requestedScope),
            );
            if (!installed && requestedScope.kind === "work") {
              onColdWorkHint?.(requestedScope.workId);
              return;
            }
            pullContextCatalogOnHint(queryClient, projectId, hint);
          })
        : undefined,
    [onColdWorkHint, projectId, queryClient, transport],
  );
}

/** Duplicate-tolerant wake hint handler; the hint never mutates cache state itself. */
export function pullContextCatalogOnHint(
  queryClient: QueryClient,
  projectId: string,
  hint: CatalogWakeHint,
): void {
  const requestedScope: CatalogScope =
    hint.scope.kind === "user" ? { kind: "user", userId: "self" } : hint.scope;
  const view = queryClient.getQueryData<CatalogCacheView>(
    projectQueryKeys.contextCatalog(projectId, requestedScope),
  );
  if (!view && requestedScope.kind !== "project") return;
  if (view?.appliedRevision === hint.headRevision) return;
  void hintContextCatalog(
    queryClient,
    projectQueryKeys.contextCatalog(projectId, requestedScope),
    projectId,
    requestedScope,
    hint.headRevision,
  );
}
