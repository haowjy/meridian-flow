/**
 * useDraftPreview — live markdown plus active AI draft preview for a document.
 *
 * What it returns is what the writer is looking at: changes with an Apply or
 * Discard in flight or confirmed are already gone from it (optimistic), and a
 * read that started before such a command cannot bring them back
 * (`branch-command-record`). Every consumer, the editor's marks included,
 * therefore agrees on which changes exist. `useDraftPreviews` reads several
 * drafts' previews the same way, and refreshes the ones no review owns.
 */
import type { DraftPreviewResponse, ThreadDraftListItem } from "@meridian/contracts/branches";
import {
  type QueryFunctionContext,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { getDraftPreview } from "@/client/api/branches-api";
import { projectQueryKeys } from "./project-query-keys";
import { workBranchDraftsQueryOptions } from "./useWorkBranchDrafts";

/**
 * `preview` is what the writer has left to review. `inline` is the same read
 * for the manuscript's marks: it still holds the changes being discarded, named
 * in `restoring`, so the editor can draw their original text from the click
 * (nothing else reads it).
 */
export type DraftPreviewState = {
  preview: DraftPreviewResponse | null;
  inline: null;
  /** The read itself, before any intent: what a held view re-projects as the intents change. */
  observed: DraftPreviewResponse | null;
};

type DraftRef = {
  projectId: string;
  workId: string;
  documentId: string;
  itemKey: string;
  draftGeneration?: number;
};

/** The cache never goes back a generation. */
export type DraftPreviewRead = DraftPreviewResponse & { draftGeneration?: number };
function keepNewerGeneration(prior: unknown, next: unknown): unknown {
  const before = prior as DraftPreviewRead | undefined;
  const after = next as DraftPreviewRead;
  return before?.draftGeneration !== undefined &&
    after.draftGeneration !== undefined &&
    after.draftGeneration < before.draftGeneration
    ? before
    : after;
}

export function draftPreviewQueryOptions(draft: DraftRef) {
  const queryKey = projectQueryKeys.workDraftPreview(
    draft.projectId,
    draft.workId,
    draft.documentId,
    draft.itemKey,
  );
  return {
    queryKey,
    queryFn: async ({ signal }: QueryFunctionContext): Promise<DraftPreviewRead> =>
      getDraftPreview(draft.projectId, draft.workId, draft.documentId, draft.itemKey, signal).catch(
        (error: unknown) => {
          if (error && typeof error === "object" && "status" in error && error.status === 404)
            return { status: "gone" as const, itemKey: draft.itemKey };
          throw error;
        },
      ),
    staleTime: 15_000,
    structuralSharing: keepNewerGeneration,
  };
}

export function useDraftPreview(
  projectId: string | null,
  workId: string | null,
  documentId: string | null,
  itemKey: string | null,
  options?: { enabled?: boolean },
): DraftPreviewState {
  const enabled =
    (options?.enabled ?? true) && Boolean(projectId && workId && documentId && itemKey);
  const { data } = useQuery({
    ...draftPreviewQueryOptions({
      projectId: projectId ?? "",
      workId: workId ?? "",
      documentId: documentId ?? "",
      itemKey: itemKey ?? "",
    }),
    enabled,
  });
  return { preview: data ?? null, inline: null, observed: data ?? null };
}

/**
 * One draft's preview as a caller of `useDraftPreviews` sees it. A failed or
 * unread preview is never "no changes": `loading` and `error` say so.
 */
export type DraftPreviewEntry =
  | { status: "loading" }
  | { status: "error"; retry: () => void }
  | { status: "ready"; preview: DraftPreviewResponse };

const NO_ENTRIES: readonly DraftPreviewEntry[] = [];

type PreviewRead = { data: DraftPreviewResponse | undefined; failed: boolean; retry: () => void };

function combinePreviewReads(
  all: {
    data: DraftPreviewResponse | undefined;
    isError: boolean;
    refetch: () => unknown;
  }[],
): PreviewRead[] {
  return all.map(({ data, isError, refetch }) => ({
    data,
    failed: isError,
    retry: () => void refetch(),
  }));
}

function previewKeyOf(draft: DraftRef): string {
  return `${draft.projectId}\u0000${draft.workId}\u0000${draft.documentId}\u0000${draft.itemKey}`;
}

/**
 * The `updatedAt` each target's draft carries in its Work's draft list (the
 * list the catalog wake re-reads), or undefined while the list or the row is
 * not there. Reads the shared list query, so it costs no extra fetch.
 */
function useDraftListRows(targets: readonly DraftRef[]): (string | undefined)[] {
  const scopes = [...new Map(targets.map((t) => [`${t.projectId}\u0000${t.workId}`, t])).values()];
  const lists = useQueries({
    queries: scopes.map(({ projectId, workId }) => workBranchDraftsQueryOptions(projectId, workId)),
    combine: useCallback(
      (all: { data?: { itemKey: string; updatedAt: string }[] }[]) =>
        all.map(({ data }) =>
          data?.map(({ itemKey, updatedAt }) => `${itemKey}\u0000${updatedAt}`),
        ),
      [],
    ),
  });
  return targets.map((target) => {
    const at = scopes.findIndex(
      (scope) => scope.projectId === target.projectId && scope.workId === target.workId,
    );
    const prefix = `${target.itemKey}\u0000`;
    return lists[at]?.find((row) => row.startsWith(prefix))?.slice(prefix.length);
  });
}

/**
 * The previews of several drafts at once: the same fenced read (the shared
 * query) and the same hidden-operation projection as `useDraftPreview`, so a
 * change the writer has applied or discarded is gone from every count.
 *
 * The refresh owner of a target that is not the open review. When its draft's
 * list row changes (`updatedAt`; the catalog wake's draft-list re-read brings
 * it: the AI wrote, the writer typed, a peer applied) its one preview key is
 * invalidated. Nothing unmounted is refreshed and no review room is joined. The
 * open review keeps `useReviewRefresh`: pass it as `openReview` so it is not
 * read twice.
 */
export function useDraftPreviews(
  targets: readonly DraftRef[],
  options?: { openReview?: { documentId: string; itemKey: string } | null },
): readonly DraftPreviewEntry[] {
  const queryClient = useQueryClient();
  const reads = useQueries({
    queries: targets.map((target) => draftPreviewQueryOptions(target)),
    combine: combinePreviewReads,
  });

  const listedAt = useDraftListRows(targets);
  const open = options?.openReview ?? null;
  const seen = useRef(new Map<string, string>());
  const targetsKey = targets.map(previewKeyOf).join("\u0001");
  const listedKey = listedAt.join("\u0001");
  useEffect(() => {
    const held = new Set<string>();
    targets.forEach((target, index) => {
      const key = previewKeyOf(target);
      held.add(key);
      const updatedAt = listedAt[index];
      if (updatedAt === undefined) return;
      const prior = seen.current.get(key);
      seen.current.set(key, updatedAt);
      const isOpen = open?.documentId === target.documentId && open.itemKey === target.itemKey;
      if (prior === undefined || prior === updatedAt || isOpen) return;
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workDraftPreview(
          target.projectId,
          target.workId,
          target.documentId,
          target.itemKey,
        ),
      });
    });
    for (const key of seen.current.keys()) if (!held.has(key)) seen.current.delete(key);
  }, [targetsKey, listedKey, open?.documentId, open?.itemKey, queryClient]);

  return useMemo(() => {
    if (targets.length === 0) return NO_ENTRIES;
    return reads.map(({ data, failed, retry }): DraftPreviewEntry => {
      if (data?.status === "corrupt") return { status: "error", retry };
      if (data) return { status: "ready", preview: data };
      return failed ? { status: "error", retry } : { status: "loading" };
    });
  }, [reads, targetsKey]);
}
