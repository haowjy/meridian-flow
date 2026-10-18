/**
 * useWorkBranches — reviewable AI draft list for one Work.
 *
 * Projects one catalog-labelled file per active document draft, in stable order.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { listWorkBranches } from "@/client/api/branches-api";
import {
  readBranchesAfterCommands,
  shareDraftObservation,
  useChangeCommandRecords,
} from "./branch-command-record";
import { projectDraftList } from "./draft-projection";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { useContextCatalogViews } from "./useContextCatalog";
import { projectWorkBranchFiles, type ReviewFileTarget } from "./work-branch-files";

export type ThreadBranchesStatus = ListQueryStatus<ThreadDraftListItem> & {
  /** Raw query rows for generation evidence and command fences. */
  branches: ThreadDraftListItem[] | null;
  files: ReviewFileTarget[] | null;
  fileForDocument: (documentId: string | null | undefined) => ReviewFileTarget | null;
};

/** The one Work draft-list query, shared by every reader so the list is fetched once. */
export function workBranchesQueryOptions(projectId: string, workId: string) {
  return {
    queryKey: projectQueryKeys.workBranches(projectId, workId),
    queryFn: () =>
      readBranchesAfterCommands({ projectId, workId }, () =>
        listWorkBranches(projectId, workId).then((response) => response.items),
      ),
    staleTime: 15_000,
    structuralSharing: shareDraftObservation,
  };
}

export function useWorkBranches(
  projectId: string | null,
  workId: string | null,
  options?: { enabled?: boolean },
): ThreadBranchesStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(projectId) && Boolean(workId);
  const result = unwrapListQuery(
    useQuery({
      ...workBranchesQueryOptions(projectId ?? "", workId ?? ""),
      enabled,
    }),
  );

  const schemes = useMemo(
    () => [
      ...new Set(
        result.data?.flatMap((row) => (row.contextLocation ? [row.contextLocation.scheme] : [])),
      ),
    ],
    [result.data],
  );
  const catalogs = useContextCatalogViews(projectId ?? "", schemes, {
    enabled: enabled && Boolean(result.data?.length),
    workId,
  });
  const records = useChangeCommandRecords();
  const visible = useMemo(
    () =>
      result.data
        ? projectDraftList(
            result.data,
            { projectId: projectId ?? "", workId: workId ?? "" },
            records,
          )
        : null,
    [result.data, projectId, workId, records],
  );
  const files = useMemo(
    () =>
      enabled && visible
        ? projectWorkBranchFiles(visible, {
            findDocument: (id) =>
              Object.values(catalogs)
                .flatMap(({ catalog }) => catalog?.findDocument(id) ?? [])
                .at(0) ?? null,
          })
        : null,
    [enabled, visible, catalogs],
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
      branches: null,
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
    branches: result.data,
    files,
    fileForDocument,
  };
}
