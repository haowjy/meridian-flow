/**
 * useDraftMeta: where to open one item. The server answers with metadata only (`DraftItemMeta`: the
 * item's room by name, whether it is new, whether its text differs from its base); the review itself is
 * computed in the browser from that room (`review-runtime.ts`). A 404 is the one durable "closed" answer
 * (`gone`): a list omitting the item is never read as one.
 */
import type { DraftItemMeta, ThreadDraftListItem } from "@meridian/contracts/drafts";
import { type QueryClient, type QueryFunctionContext, useQuery } from "@tanstack/react-query";

import { getDraftMeta } from "@/client/api/drafts-api";
import { httpErrorStatus } from "@/client/api/http-client";
import { projectQueryKeys } from "./project-query-keys";

export type DraftMetaRef = {
  projectId: string;
  workId: string;
  documentId: string;
  itemKey: string;
};

/** What an item's metadata read says: the item as it is, or that it is closed. */
export type DraftMeta = DraftItemMeta | { kind: "gone"; itemKey: string };
export type TextDraftMeta = Extract<DraftMeta, { kind: "text" }>;

/** The item's room, when it has one. */
export function metaRoomName(meta: DraftMeta | null | undefined): string | null {
  return meta?.kind === "text" ? meta.roomName : null;
}

/** The one metadata query, shared by every reader so each item's room is looked up once. */
export function draftMetaQueryOptions(draft: DraftMetaRef) {
  return {
    queryKey: projectQueryKeys.workDraftMeta(
      draft.projectId,
      draft.workId,
      draft.documentId,
      draft.itemKey,
    ),
    queryFn: async ({ signal }: QueryFunctionContext): Promise<DraftMeta> => {
      try {
        return await getDraftMeta(
          draft.projectId,
          draft.workId,
          draft.documentId,
          draft.itemKey,
          signal,
        );
      } catch (error) {
        if (httpErrorStatus(error) === 404) return { kind: "gone", itemKey: draft.itemKey };
        throw error;
      }
    },
    staleTime: 15_000,
  };
}

export function useDraftMeta(
  draft: Partial<DraftMetaRef> | null,
  options?: { enabled?: boolean },
): { meta: DraftMeta | null; failed: boolean; retry: () => void } {
  const ref = {
    projectId: draft?.projectId ?? "",
    workId: draft?.workId ?? "",
    documentId: draft?.documentId ?? "",
    itemKey: draft?.itemKey ?? "",
  };
  const enabled =
    (options?.enabled ?? true) &&
    Boolean(ref.projectId && ref.workId && ref.documentId && ref.itemKey);
  const { data, isError, refetch } = useQuery({ ...draftMetaQueryOptions(ref), enabled });
  return { meta: data ?? null, failed: isError, retry: () => void refetch() };
}

/**
 * Whether the item is one whole change (a created, binary or live-deleted item), from what the caches
 * hold: its list row, else its metadata. Only item-level commands act on such an item.
 */
export function isWholeItem(queryClient: QueryClient, draft: DraftMetaRef): boolean {
  const row = queryClient
    .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(draft.projectId, draft.workId))
    ?.find((item) => item.itemKey === draft.itemKey);
  if (row) return row.wholeItem;
  const meta = queryClient.getQueryData<DraftMeta>(draftMetaQueryOptions(draft).queryKey);
  return meta !== undefined && meta.kind !== "gone" && meta.wholeItem;
}
