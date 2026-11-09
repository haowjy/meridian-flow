/**
 * useOwnerDrafts — reviewable AI draft list for one owner (one entry per document).
 *
 * Projects one catalog-labelled file per active document draft, in stable order.
 */
import { parseDraftOwnerKey, type ThreadDraftListItem } from "@meridian/contracts/branches";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { listOwnerDrafts } from "@/client/api/branches-api";
import { projectReadEnabled } from "@/client/creation/project-read-gate";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { useContextCatalogViews } from "./useContextCatalog";
import { projectWorkBranchFiles, type ReviewFileTarget } from "./work-branch-files";

export type OwnerDraftListStatus = ListQueryStatus<ThreadDraftListItem> & {
  /** Raw query rows for generation evidence and command fences. */
  drafts: ThreadDraftListItem[] | null;
  files: ReviewFileTarget[] | null;
  fileForDocument: (documentId: string | null | undefined) => ReviewFileTarget | null;
};

/** The one owner draft-list query, shared by every reader so the list is fetched once. */
/** The catalog owner whose Scratch names this draft owner's documents. */
export function catalogOwnerOf(owner: string | null): { workId?: string; rootThreadId?: string } {
  const parsed = owner ? parseDraftOwnerKey(owner) : null;
  if (!parsed) return {};
  return parsed.kind === "work" ? { workId: parsed.id } : { rootThreadId: parsed.id };
}

export function ownerDraftsQueryOptions(projectId: string, owner: string) {
  return {
    queryKey: projectQueryKeys.ownerDrafts(projectId, owner),
    queryFn: () => listOwnerDrafts(projectId, owner).then((response) => response.items),
    staleTime: 15_000,
  };
}

export function useOwnerDrafts(
  projectId: string | null,
  owner: string | null,
  options?: { enabled?: boolean },
): OwnerDraftListStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(projectId) && Boolean(owner);
  const result = unwrapListQuery(
    useQuery({
      ...ownerDraftsQueryOptions(projectId ?? "", owner ?? ""),
      enabled: projectReadEnabled(enabled),
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
    ...catalogOwnerOf(owner),
  });
  const visible = result.data;
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
