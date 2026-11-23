/**
 * useOwnerDrafts — one draft's review items (one per document).
 *
 * Projects one tree-labelled file per document the draft changes, in stable order.
 */
import type { DraftItem, DraftItemsResponse } from "@meridian/contracts/drafts";
import type { WorksSnapshot } from "@meridian/contracts/works";
import { type QueryClient, useQueries } from "@tanstack/react-query";
import { useMemo, useRef } from "react";

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

/** One draft's list as `useOwnerDraftLists` reads it: the list query with its rows completed. */
export type OwnerDraftListQuery = {
  data: DraftItemsResponse | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => unknown;
};

/**
 * Drafts' lists as this browser knows them, read together, by draft: the server's rows, then the
 * drafts its pending creates make that the server has not listed yet (`useCreatedDrafts`), each
 * open document's text changes counted from its editor (`withTabChangeCounts`).
 */
export function useOwnerDraftLists(
  projectId: string,
  owners: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, OwnerDraftListQuery> {
  const queries = useQueries({
    queries: owners.map((owner) => ({
      ...ownerDraftsQueryOptions(projectId, owner),
      enabled: projectReadEnabled(enabled),
    })),
  });
  // What the lists' reads say now: the memos below rebuild only when it changes.
  const read = queries
    .map((query) => `${query.dataUpdatedAt}:${query.isPending}${query.isFetching}${query.isError}`)
    .join();
  const latest = useRef(queries);
  latest.current = queries;
  const listed = useMemo(() => {
    const map = new Map<string, readonly DraftItem[]>();
    owners.forEach((owner, index) => {
      const data = latest.current[index]?.data;
      if (enabled && data) map.set(owner, data.items);
    });
    return map;
  }, [owners, enabled, read]);
  const created = useCreatedDrafts(projectId, listed);
  const tab = useTabChangeCounts();
  return useMemo(() => {
    const lists = new Map<string, OwnerDraftListQuery>();
    owners.forEach((owner, index) => {
      const query = latest.current[index];
      if (!query) return;
      const data = query.data;
      const made = created.get(owner);
      const items = data
        ? withTabChangeCounts(made ? [...data.items, ...made] : data.items, owner, tab)
        : undefined;
      lists.set(owner, {
        data: data && items && items !== data.items ? { ...data, items } : data,
        isPending: query.isPending,
        isFetching: query.isFetching,
        isError: query.isError,
        refetch: query.refetch,
      });
    });
    return lists;
  }, [owners, read, created, tab]);
}

/** One draft's list (`useOwnerDraftLists`). */
export function useOwnerDraftList(
  projectId: string,
  owner: string,
  enabled: boolean,
): OwnerDraftListQuery {
  const owners = useMemo(() => [owner], [owner]);
  return useOwnerDraftLists(projectId, owners, enabled).get(owner) as OwnerDraftListQuery;
}

const DISABLED = {
  data: null,
  status: "disabled",
  isError: false,
  isFetching: false,
  refetch: () => {},
  files: null,
  fileForDocument: () => null,
  draftId: null,
} as const satisfies OwnerDraftListStatus;

/**
 * Drafts' review items, one file per document each, by draft. The drafts are one owner's (a
 * Work's, or a chat's one): its Scratch names their documents.
 */
export function useDraftLists(
  projectId: string | null,
  owners: readonly string[],
  options?: { enabled?: boolean },
): ReadonlyMap<string, OwnerDraftListStatus> {
  const enabled = (options?.enabled ?? true) && Boolean(projectId) && owners.length > 0;
  const lists = useOwnerDraftLists(projectId ?? "", owners, enabled);
  const treeOwner = useDraftTreeOwner(projectId ?? "", owners[0] ?? null);
  const schemes = useMemo(
    () => [
      ...new Set(
        [...lists.values()].flatMap(
          (list) =>
            list.data?.items.flatMap((row) =>
              row.contextLocation ? [row.contextLocation.scheme] : [],
            ) ?? [],
        ),
      ),
    ],
    [lists],
  );
  const trees = useProjectTreeViews(projectId ?? "", schemes, {
    enabled: enabled && schemes.length > 0,
    ...treeOwner,
  });
  return useMemo(() => {
    const statuses = new Map<string, OwnerDraftListStatus>();
    for (const [owner, query] of lists) {
      if (!enabled) {
        statuses.set(owner, DISABLED);
        continue;
      }
      const result = unwrapListQuery({ ...query, data: query.data?.items });
      const visible = result.data;
      const files = visible
        ? projectWorkDraftFiles(visible, {
            findDocument: (id) =>
              Object.values(trees)
                .flatMap(({ tree }) => tree?.findDocument(id) ?? [])
                .at(0) ?? null,
          })
        : null;
      const byDocument = new Map(files?.map((file) => [file.documentId, file]));
      statuses.set(owner, {
        ...result,
        status:
          result.status === "ready" || result.status === "empty"
            ? visible?.length
              ? "ready"
              : "empty"
            : result.status,
        files,
        fileForDocument: (documentId) => (documentId ? (byDocument.get(documentId) ?? null) : null),
        draftId: query.data ? owner : null,
      });
    }
    return statuses;
  }, [lists, enabled, trees]);
}

export function useOwnerDrafts(
  projectId: string | null,
  owner: string | null,
  options?: { enabled?: boolean },
): OwnerDraftListStatus {
  const owners = useMemo(() => (owner ? [owner] : []), [owner]);
  return useDraftLists(projectId, owners, options).get(owner ?? "") ?? DISABLED;
}
