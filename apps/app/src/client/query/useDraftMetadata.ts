/** Addressed SQL metadata, from the owner's list where it holds the draft. Empty active drafts remain open independently of the pending list. */
import type { DraftMetadataResponse, ThreadDraftListItem } from "@meridian/contracts/branches";
import { draftRoomName } from "@meridian/contracts/protocol";
import { type QueryClient, useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { getDraftMetadata } from "@/client/api/branches-api";
import type { DraftRef } from "@/features/draft-review/review-command-types";
import { projectQueryKeys } from "./project-query-keys";
import { useOwnerDraftList } from "./useOwnerDrafts";

/**
 * A draft's metadata as this tab read it: `readAt` is when the read started, the time an answer
 * speaks for. A read that started before a close may land after it, so ordering by landing time
 * would let a stale `active` reopen a closed draft.
 */
export type DraftMetadataAnswer = DraftMetadataResponse & { readAt: number };

async function readDraftMetadata(draft: DraftRef, signal?: AbortSignal) {
  const readAt = Date.now();
  return { ...(await getDraftMetadata(draft, signal)), readAt } as DraftMetadataAnswer;
}

function draftMetadataQueryOptions(draft: DraftRef) {
  return {
    queryKey: projectQueryKeys.ownerDraftMetadata(
      draft.projectId,
      draft.ownerKey,
      draft.documentId,
      draft.itemKey,
    ),
    queryFn: ({ signal }: { signal: AbortSignal }) => readDraftMetadata(draft, signal),
    staleTime: 15_000,
  };
}
/** A listed row's metadata: the row names its draft, so it needs no read of its own. */
function listedMetadata(item: ThreadDraftListItem, readAt: number): DraftMetadataAnswer {
  return item.draftId
    ? {
        status: "active",
        draftId: item.draftId,
        reviewRoomName: draftRoomName(item.draftId),
        item,
        readAt,
      }
    : { status: "tree-only", item, readAt };
}

/**
 * One owner's drafts' metadata. A draft the owner's list holds answers from its row, so a review
 * of many drafts reads one list, not one address per draft; only a draft the list doesn't hold
 * (an empty draft, or one the list dropped) reads its own address. A row the owner's pending
 * creates make (`useCreatedDrafts`) speaks for no read time: it never reopens a draft this tab
 * saw end.
 *
 * Each row's answer is also stored as the draft's own answer, which every surface shares: when
 * the list drops the row, a surface that mounts then still finds its room, and the draft's own
 * read, older than the list that dropped it, is asked again.
 */
export function useDraftMetadata(drafts: readonly DraftRef[]) {
  const owner = drafts[0];
  const queryClient = useQueryClient();
  const list = useOwnerDraftList(
    owner?.projectId ?? "",
    owner?.ownerKey ?? "",
    owner !== undefined,
  );
  const rows = useMemo(
    () => new Map((list.data?.items ?? []).map((row) => [row.itemKey, row])),
    [list.data],
  );
  const listedAnswer = (draft: DraftRef) => {
    const item = rows.get(draft.itemKey);
    return item && list.data
      ? listedMetadata(item, list.created.includes(item) ? 0 : list.data.readAt)
      : null;
  };
  const results = useQueries({
    queries: drafts.map((draft) => ({
      ...draftMetadataQueryOptions(draft),
      enabled: !rows.has(draft.itemKey),
    })),
  });
  const draftsKey = JSON.stringify(drafts.map((draft) => draft.itemKey));
  useEffect(() => {
    const listReadAt = list.data?.readAt;
    if (listReadAt === undefined) return;
    for (const draft of drafts) {
      const { queryKey } = draftMetadataQueryOptions(draft);
      const answer = listedAnswer(draft);
      const held = queryClient.getQueryData<DraftMetadataAnswer>(queryKey);
      if (answer) {
        if (!held || answer.readAt >= held.readAt)
          queryClient.setQueryData(queryKey, answer, { updatedAt: answer.readAt });
      } else if (held && held.readAt < listReadAt)
        void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  }, [list.data, draftsKey, queryClient]);
  return results.map((result, index) => {
    const answer = listedAnswer(drafts[index]);
    if (!answer) {
      // Older than the list that dropped its row: asked again from this render on (the effect),
      // so a surface waits for that answer instead of taking the draft for unavailable.
      const stale =
        result.data !== undefined &&
        list.data !== undefined &&
        result.data.readAt < list.data.readAt;
      return stale ? ({ ...result, isFetching: true } as typeof result) : result;
    }
    return {
      ...result,
      data: answer,
      dataUpdatedAt: list.dataUpdatedAt,
      // The row is re-read with its list.
      isFetching: list.isFetching,
      error: null,
      isError: false,
      status: "success",
      refetch: list.refetch,
    } as unknown as typeof result;
  });
}

/**
 * A read that starts now, so it cannot report a disposition older than the question. It goes to
 * the server, not through the cached query: a restore or a wake hint invalidates that query, and
 * the refetch would cancel a read joined to it, which callers would take as no answer. It
 * replaces the cached answer only when it started after that answer was stored.
 */
export async function fetchCurrentDraftMetadata(
  queryClient: QueryClient,
  draft: DraftRef,
): Promise<DraftMetadataAnswer> {
  const answer = await readDraftMetadata(draft);
  const { queryKey } = draftMetadataQueryOptions(draft);
  const held = queryClient.getQueryState(queryKey);
  if (!held || answer.readAt > held.dataUpdatedAt)
    queryClient.setQueryData(queryKey, answer, { updatedAt: answer.readAt });
  return answer;
}
