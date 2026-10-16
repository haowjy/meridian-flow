/**
 * useWorkDrafts — reviewable AI draft list for one Work.
 *
 * Projects one catalog-labelled file per active document draft, in stable order.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { getThreadDraftFiles, listWorkDrafts } from "@/client/api/drafts-api";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { useContextCatalogViews } from "./useContextCatalog";
import { projectWorkDraftFiles, type ReviewFileTarget } from "./work-draft-files";

export type ThreadDraftsStatus = ListQueryStatus<ThreadDraftListItem> & {
  /** Every listed item row (contract §4). A row's absence is never evidence that its item closed. */
  drafts: ThreadDraftListItem[] | null;
  /** The listed items as files, in the one file order. */
  files: ReviewFileTarget[] | null;
  fileForDocument: (documentId: string | null | undefined) => ReviewFileTarget | null;
};

/** The one Work draft-list query, shared by every reader so the list is fetched once. */
export function workDraftsQueryOptions(projectId: string, workId: string) {
  return {
    queryKey: projectQueryKeys.workDrafts(projectId, workId),
    queryFn: () => listWorkDrafts(projectId, workId).then((response) => response.items),
    staleTime: 15_000,
  };
}

/** Catalog-labelled files for the listed items, in the one file order. */
function useDraftFileProjection(
  projectId: string | null,
  workId: string | null,
  rows: ThreadDraftListItem[] | undefined,
  enabled: boolean,
) {
  const schemes = useMemo(
    () => [
      ...new Set(rows?.flatMap((row) => (row.contextLocation ? [row.contextLocation.scheme] : []))),
    ],
    [rows],
  );
  const catalogs = useContextCatalogViews(projectId ?? "", schemes, {
    enabled: enabled && Boolean(rows?.length),
    workId,
  });
  const visible = rows ?? null;
  const findDocument = useCallback(
    (id: string) =>
      Object.values(catalogs)
        .flatMap(({ catalog }) => catalog?.findDocument(id) ?? [])
        .at(0) ?? null,
    [catalogs],
  );
  const files = useMemo(
    () => (enabled && visible ? projectWorkDraftFiles(visible, { findDocument }) : null),
    [enabled, visible, findDocument],
  );
  return { visible, files };
}

/**
 * The drafts a chat has pending AI edits in (SQL only on the server: no decode, no projection), as files.
 * Invalidated with the Work's draft list.
 */
export function useThreadDraftFiles(
  projectId: string | null,
  workId: string | null,
  threadId: string,
): ReviewFileTarget[] {
  const enabled = Boolean(projectId) && Boolean(workId);
  const { data } = useQuery({
    queryKey: [...projectQueryKeys.workDrafts(projectId ?? "", workId ?? ""), "thread", threadId],
    queryFn: () => getThreadDraftFiles(threadId).then((response) => response.drafts),
    staleTime: 15_000,
    enabled,
  });
  return useDraftFileProjection(projectId, workId, data, enabled).files ?? NO_FILES;
}

const NO_FILES: ReviewFileTarget[] = [];

export function useWorkDrafts(
  projectId: string | null,
  workId: string | null,
  options?: { enabled?: boolean },
): ThreadDraftsStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(projectId) && Boolean(workId);
  const result = unwrapListQuery(
    useQuery({
      ...workDraftsQueryOptions(projectId ?? "", workId ?? ""),
      enabled,
    }),
  );

  const { visible, files } = useDraftFileProjection(
    projectId,
    workId,
    result.data ?? undefined,
    enabled,
  );
  const byDocument = useMemo(() => new Map(files?.map((file) => [file.documentId, file])), [files]);
  const fileForDocument = useCallback(
    (documentId: string | null | undefined) =>
      documentId ? (byDocument.get(documentId) ?? null) : null,
    [byDocument],
  );

  if (!enabled) {
    return {
      ...result,
      data: null,
      status: "disabled",
      drafts: null,
      files: null,
      fileForDocument,
    };
  }

  return {
    ...result,
    data: visible,
    status:
      result.status === "ready" || result.status === "empty"
        ? visible?.length
          ? "ready"
          : "empty"
        : result.status,
    drafts: result.data,
    files,
    fileForDocument,
  };
}
