/** Addressed SQL metadata only. Empty active drafts remain open independently of the pending list. */
import type { DraftMetadataResponse } from "@meridian/contracts/branches";
import { type QueryClient, useQueries } from "@tanstack/react-query";
import { getDraftMetadata } from "@/client/api/branches-api";
import type { DraftRef } from "@/features/draft-review/review-command-types";
import { createdDraftMetadata } from "./created-drafts";
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

export function draftMetadataQueryOptions(draft: DraftRef) {
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
/**
 * One owner's drafts' metadata. A draft the owner's pending creates make answers from the list
 * (`useCreatedDrafts`) until the server has made it: the server may not have heard of the create.
 */
export function useDraftMetadata(drafts: readonly DraftRef[]) {
  const results = useQueries({ queries: drafts.map(draftMetadataQueryOptions) });
  const owner = drafts[0];
  const { created } = useOwnerDraftList(
    owner?.projectId ?? "",
    owner?.ownerKey ?? "",
    owner !== undefined,
  );
  return results.map((result, index) => {
    const item = created.find((row) => row.itemKey === drafts[index]?.itemKey);
    if (!item || result.data?.status === "active") return result;
    return {
      ...result,
      // The list's own word, read at no time: it never reopens a draft this tab saw end.
      data: { ...createdDraftMetadata(item), readAt: 0 },
      error: null,
      isError: false,
      status: "success",
    } as typeof result;
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
