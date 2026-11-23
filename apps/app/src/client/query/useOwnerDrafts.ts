/**
 * useOwnerDrafts — one draft's review items (one per document).
 *
 * Projects one tree-labelled file per document the draft changes, in stable order.
 */
import type { DraftItem, DraftItemsResponse } from "@meridian/contracts/drafts";
import type { WorksSnapshot } from "@meridian/contracts/works";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { listOwnerDrafts } from "@/client/api/drafts-api";
import { useCreatedDrafts } from "./created-drafts";
import { bumpLinkResolutionEpoch } from "./link-resolution-epoch";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";
import { useTabChangeCounts, withTabChangeCounts } from "./tab-change-counts";
import { useProjectThreads } from "./useProjectThreads";
import { useProjectTreeViews } from "./useProjectTree";
import { useWorks } from "./useWorks";
import { projectWorkDraftFiles, type ReviewFileTarget } from "./work-draft-files";
import { refreshWorksSnapshotSince } from "./works-projection-acquisition";

export type OwnerDraftListStatus = ListQueryStatus<DraftItem> & {
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

/**
 * Reads again what shows drafts' state after a change that committed at `since`: their lists
 * (every draft's when `drafts` holds `undefined`), a Work's row in the Works list (its count and
 * lifecycle), the documents' draft hints and link resolution. A list's read already out is
 * restarted: it may predate the change.
 */
export function refreshDraftReads(
  queryClient: QueryClient,
  projectId: string,
  drafts: ReadonlySet<string | undefined>,
  since = Date.now(),
): Promise<unknown> {
  const all = drafts.has(undefined);
  const named = [...drafts].filter((draft): draft is string => draft !== undefined);
  const reads: Promise<unknown>[] = (all ? [undefined] : named).map((draft) =>
    queryClient.invalidateQueries({
      queryKey:
        draft === undefined
          ? projectQueryKeys.draftsOf(projectId)
          : projectQueryKeys.drafts(projectId, draft),
    }),
  );
  const works = queryClient.getQueryData<WorksSnapshot>(projectQueryKeys.works(projectId));
  if (all || named.some((draft) => works?.works.some((work) => work.draftId === draft)))
    reads.push(refreshWorksSnapshotSince(queryClient, projectId, since));
  reads.push(
    queryClient.invalidateQueries({ queryKey: projectQueryKeys.documentDraftHintsOf(projectId) }),
    // A Work's drafts carry their counts.
    queryClient.invalidateQueries({ queryKey: projectQueryKeys.workDraftsOf(projectId) }),
  );
  bumpLinkResolutionEpoch(projectId);
  return Promise.allSettled(reads);
}

/** The owner's cached draft rows, without fetching. */
export function cachedOwnerDrafts(
  queryClient: QueryClient,
  projectId: string,
  owner: string,
): DraftItem[] | undefined {
  return queryClient.getQueryData<DraftItemsResponse>(projectQueryKeys.drafts(projectId, owner))
    ?.items;
}

/** Rewrites the owner's cached draft rows until the next read replaces them. */
export function patchOwnerDrafts(
  queryClient: QueryClient,
  projectId: string,
  owner: string,
  update: (items: DraftItem[]) => DraftItem[],
): void {
  queryClient.setQueryData<DraftItemsResponse>(
    projectQueryKeys.drafts(projectId, owner),
    (response) => (response ? { ...response, items: update(response.items) } : response),
  );
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
    files,
    fileForDocument,
    draftId: query.data ? owner : null,
  };
}
