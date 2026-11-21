/**
 * useOwnerDrafts — reviewable AI draft list for one draft (one entry per document).
 *
 * Projects one tree-labelled file per document the draft changes, in stable order.
 */
import type { ThreadDraftListItem, ThreadDraftListResponse } from "@meridian/contracts/drafts";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { listOwnerDrafts } from "@/client/api/drafts-api";
import { useCreatedDrafts } from "./created-drafts";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";
import { useTabChangeCounts, withTabChangeCounts } from "./tab-change-counts";
import { useProjectThreads } from "./useProjectThreads";
import { useProjectTreeViews } from "./useProjectTree";
import { useWorks } from "./useWorks";
import { projectWorkDraftFiles, type ReviewFileTarget } from "./work-draft-files";

export type OwnerDraftListStatus = ListQueryStatus<ThreadDraftListItem> & {
  /** Raw query rows for generation evidence and command fences. */
  drafts: ThreadDraftListItem[] | null;
  files: ReviewFileTarget[] | null;
  fileForDocument: (documentId: string | null | undefined) => ReviewFileTarget | null;
  /** The owner's active draft: the `draft` of its tree records. */
  draftId: string | null;
};

/** The tree owner whose Scratch names this draft's documents: the Work or root chat naming it. */
function useDraftTreeOwner(
  projectId: string,
  draft: string | null,
): { workId?: string; rootThreadId?: string } {
  const { works, deleted } = useWorks(projectId, { enabled: Boolean(draft) });
  const { threads } = useProjectThreads(projectId, { enabled: Boolean(draft) });
  return useMemo(() => {
    if (!draft) return {};
    const work = [...(works ?? []), ...deleted].find((each) => each.draftId === draft);
    if (work) return { workId: work.id };
    const root = threads?.find(
      (thread) => thread.id === thread.rootThreadId && thread.draftId === draft,
    );
    return root ? { rootThreadId: root.id } : {};
  }, [draft, works, deleted, threads]);
}

/** The one owner draft-list query, shared by every reader so the list is fetched once. */
export function ownerDraftsQueryOptions(projectId: string, owner: string) {
  return {
    queryKey: projectQueryKeys.drafts(projectId, owner),
    queryFn: () => listOwnerDrafts(projectId, owner),
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
    projectQueryKeys.drafts(projectId, owner),
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
    projectQueryKeys.drafts(projectId, owner),
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
    queryClient.setQueryData(projectQueryKeys.drafts(projectId, owner), response);
    return true;
  }
  return false;
}

/**
 * The owner's draft list as this browser knows it: the server's rows, then the drafts its Work's
 * pending creates make that the server has not listed yet (`useCreatedDrafts`), each open
 * document's text changes counted from its editor (`withTabChangeCounts`).
 */
export function useOwnerDraftList(projectId: string, owner: string, enabled: boolean) {
  const query = useQuery({
    ...ownerDraftsQueryOptions(projectId, owner),
    enabled: projectReadEnabled(enabled),
  });
  const created = useCreatedDrafts(
    projectId,
    enabled && query.data ? owner : null,
    query.data?.items,
  );
  const tab = useTabChangeCounts();
  const data = useMemo(() => {
    if (!query.data) return query.data;
    const items = withTabChangeCounts(
      created.length > 0 ? [...query.data.items, ...created] : query.data.items,
      owner,
      tab,
    );
    return items === query.data.items ? query.data : { ...query.data, items };
  }, [query.data, created, owner, tab]);
  return { ...query, data, created };
}

export function useOwnerDrafts(
  projectId: string | null,
  owner: string | null,
  options?: { enabled?: boolean },
): OwnerDraftListStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(projectId) && Boolean(owner);
  const query = useOwnerDraftList(projectId ?? "", owner ?? "", enabled);
  const result = unwrapListQuery({ ...query, data: query.data?.items });
  const treeOwner = useDraftTreeOwner(projectId ?? "", owner);

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
    ...treeOwner,
  });
  const visible = result.data;
  const files = useMemo(
    () =>
      enabled && visible
        ? projectWorkDraftFiles(visible, {
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
      draftId: null,
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
    draftId: query.data ? owner : null,
  };
}
