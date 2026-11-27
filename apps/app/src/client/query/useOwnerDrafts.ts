import { type DraftId, draftItemKey } from "@meridian/contracts";
import type { DraftItem, DraftItemsResponse } from "@meridian/contracts/drafts";
import type { WorksSnapshot } from "@meridian/contracts/works";
import { type QueryClient, useQueries } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useOptionalDraftCommandOwner } from "@/client/account/account-composition";
import { listOwnerDrafts } from "@/client/api/drafts-api";
import { useCreatedDrafts } from "./created-drafts";
import { bumpLinkResolutionEpoch } from "./link-resolution-epoch";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";
import { useProjectThreads } from "./useProjectThreads";
import { useProjectTreeViews } from "./useProjectTree";
import { useProjectTrees } from "./useProjectTrees";
import { useWorks } from "./useWorks";
import { projectWorkDraftFiles, type ReviewFileTarget } from "./work-draft-files";
import { refreshWorksSnapshotSince } from "./works-projection-acquisition";

const noSubscription = () => () => undefined;
const zeroSnapshot = () => 0;

export type OwnerDraftListStatus = ListQueryStatus<DraftItem> & {
  files: ReviewFileTarget[] | null;
  fileForDocument: (documentId: string | null | undefined) => ReviewFileTarget | null;
  draftId: string | null;
  folderIds: readonly string[] | null;
};

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

export function ownerDraftsQueryOptions(projectId: string, owner: string) {
  return {
    queryKey: projectQueryKeys.drafts(projectId, owner),
    queryFn: () => listOwnerDrafts(projectId, owner),
    staleTime: 15_000,
  };
}

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
    queryClient.invalidateQueries({ queryKey: projectQueryKeys.workDraftsOf(projectId) }),
  );
  bumpLinkResolutionEpoch(projectId);
  return Promise.allSettled(reads);
}

export function cachedOwnerDrafts(
  queryClient: QueryClient,
  projectId: string,
  owner: string,
): DraftItem[] | undefined {
  return queryClient.getQueryData<DraftItemsResponse>(projectQueryKeys.drafts(projectId, owner))
    ?.items;
}

export type OwnerDraftListQuery = {
  data: DraftItemsResponse | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => unknown;
};

export function useOwnerDraftLists(
  projectId: string,
  owners: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, OwnerDraftListQuery> {
  const commands = useOptionalDraftCommandOwner();
  const commandRevision = useSyncExternalStore(
    commands?.subscribe ?? noSubscription,
    commands?.snapshot ?? zeroSnapshot,
    commands?.snapshot ?? zeroSnapshot,
  );
  const queries = useQueries({
    queries: owners.map((owner) => ({
      ...ownerDraftsQueryOptions(projectId, owner),
      enabled: projectReadEnabled(enabled),
    })),
  });
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
  return useMemo(() => {
    const lists = new Map<string, OwnerDraftListQuery>();
    owners.forEach((owner, index) => {
      const query = latest.current[index];
      if (!query) return;
      const read = query.data;
      const data = read
        ? {
            ...read,
            folders: (read.folders ?? []).filter(
              (folder) => !commands?.holds(draftItemKey(owner as DraftId, folder.id)),
            ),
          }
        : undefined;
      const made = created.get(owner) ?? [];
      lists.set(owner, {
        data: data
          ? {
              ...data,
              items: [...data.items, ...made].filter((item) => !commands?.holds(item.itemKey)),
            }
          : data,
        isPending: query.isPending,
        isFetching: query.isFetching,
        isError: query.isError,
        refetch: query.refetch,
      });
    });
    return lists;
  }, [owners, read, created, commands, commandRevision]);
}

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
  folderIds: null,
} as const satisfies OwnerDraftListStatus;

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
        folderIds: query.data?.folders.map((folder) => folder.id) ?? null,
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

export function useDraftOnly(
  projectId: string,
  owner: string | null,
): (documentId: string | null | undefined) => boolean {
  const drafts = useOwnerDrafts(projectId, owner);
  const live = useProjectTrees(projectId);
  return useCallback(
    (documentId) =>
      !!documentId &&
      !!drafts.fileForDocument(documentId)?.draftOnly &&
      live.isComplete &&
      !live.find(documentId),
    [drafts, live],
  );
}
