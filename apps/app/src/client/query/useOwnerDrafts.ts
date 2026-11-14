/**
 * useOwnerDrafts — reviewable AI draft list for one owner (one entry per document).
 *
 * Projects one tree-labelled file per active document draft, in stable order.
 */
import {
  parseDraftOwnerKey,
  type ThreadDraftListItem,
  type ThreadDraftListResponse,
} from "@meridian/contracts/branches";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { listOwnerDrafts } from "@/client/api/branches-api";
import { projectReadEnabled } from "@/client/creation/project-read-gate";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { useProjectTreeViews } from "./useProjectTree";
import { projectWorkBranchFiles, type ReviewFileTarget } from "./work-branch-files";

export type OwnerDraftListStatus = ListQueryStatus<ThreadDraftListItem> & {
  /** Raw query rows for generation evidence and command fences. */
  drafts: ThreadDraftListItem[] | null;
  files: ReviewFileTarget[] | null;
  fileForDocument: (documentId: string | null | undefined) => ReviewFileTarget | null;
  /** The server's word that the owner's drafts are frozen (`ThreadDraftListResponse.frozen`). */
  frozen: boolean;
};

/** The tree owner whose Scratch names this draft owner's documents. */
export function treeOwnerOf(owner: string | null): { workId?: string; rootThreadId?: string } {
  const parsed = owner ? parseDraftOwnerKey(owner) : null;
  if (!parsed) return {};
  return parsed.kind === "work" ? { workId: parsed.id } : { rootThreadId: parsed.id };
}

/** The one owner draft-list query, shared by every reader so the list is fetched once. */
export function ownerDraftsQueryOptions(projectId: string, owner: string) {
  return {
    queryKey: projectQueryKeys.ownerDrafts(projectId, owner),
    queryFn: (): Promise<ThreadDraftListResponse> => listOwnerDrafts(projectId, owner),
    staleTime: 15_000,
  };
}

/** The owner's cached draft rows, without fetching. */
export function cachedOwnerDrafts(
  queryClient: QueryClient,
  projectId: string,
  owner: string,
): ThreadDraftListItem[] | undefined {
  return queryClient.getQueryData<ThreadDraftListResponse>(
    projectQueryKeys.ownerDrafts(projectId, owner),
  )?.items;
}

/** Rewrites the owner's cached draft rows until the next read replaces them. */
export function patchOwnerDrafts(
  queryClient: QueryClient,
  projectId: string,
  owner: string,
  update: (items: ThreadDraftListItem[]) => ThreadDraftListItem[],
): void {
  queryClient.setQueryData<ThreadDraftListResponse>(
    projectQueryKeys.ownerDrafts(projectId, owner),
    (response) => (response ? { ...response, items: update(response.items) } : response),
  );
}

/**
 * Waits for the server to list an item again, then caches that list. The list omits a draft
 * until the server re-judges its effect after a write (a short debounce, longer on retry), so a
 * read made sooner would drop the row. Reads go straight to the server, leaving the cached rows
 * alone meanwhile; false when the server still omits the item after the retries.
 */
export async function relistedOwnerDraft(
  queryClient: QueryClient,
  projectId: string,
  owner: string,
  itemKey: string,
): Promise<boolean> {
  for (const delayMs of [250, 500, 1_000, 2_000, 4_000]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    // slop-lint: allow swallowed-error a failed read is one more retry, not an answer
    const response = await listOwnerDrafts(projectId, owner).catch(() => null);
    if (!response?.items.some((row) => row.itemKey === itemKey)) continue;
    queryClient.setQueryData(projectQueryKeys.ownerDrafts(projectId, owner), response);
    return true;
  }
  return false;
}

/** Whether the owner's drafts are frozen (a lineage with every chat in Trash), as last read. */
export function useOwnerDraftsFrozen(projectId: string, owner: string): boolean {
  return (
    useQuery({
      ...ownerDraftsQueryOptions(projectId, owner),
      select: (response) => response.frozen,
      enabled: projectReadEnabled(Boolean(projectId) && Boolean(owner)),
    }).data ?? false
  );
}

export function useOwnerDrafts(
  projectId: string | null,
  owner: string | null,
  options?: { enabled?: boolean },
): OwnerDraftListStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(projectId) && Boolean(owner);
  const query = useQuery({
    ...ownerDraftsQueryOptions(projectId ?? "", owner ?? ""),
    enabled: projectReadEnabled(enabled),
  });
  const result = unwrapListQuery({ ...query, data: query.data?.items });

  const schemes = useMemo(
    () => [
      ...new Set(
        result.data?.flatMap((row) => (row.contextLocation ? [row.contextLocation.scheme] : [])),
      ),
    ],
    [result.data],
  );
  const trees = useProjectTreeViews(projectId ?? "", schemes, {
    enabled: enabled && Boolean(result.data?.length),
    ...treeOwnerOf(owner),
  });
  const visible = result.data;
  const files = useMemo(
    () =>
      enabled && visible
        ? projectWorkBranchFiles(visible, {
            findDocument: (id) =>
              Object.values(trees)
                .flatMap(({ tree }) => tree?.findDocument(id) ?? [])
                .at(0) ?? null,
          })
        : null,
    [enabled, visible, trees],
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
      frozen: false,
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
    frozen: query.data?.frozen ?? false,
  };
}
