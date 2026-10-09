/**
 * useDraftPreview — live markdown plus active AI draft preview for a document.
 *
 * What it returns is what the writer is looking at: changes with an Apply or
 * Discard in flight or confirmed are already gone from it (optimistic), and a
 * read that started before such a command cannot bring them back
 * (`change-command-record`). Every consumer, the editor's marks included,
 * therefore agrees on which changes exist. `useDraftPreviews` reads several
 * drafts' previews the same way, and refreshes the ones no review owns.
 */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { replaceEqualDeep, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { getDraftPreview } from "@/client/api/drafts-api";
import {
  type ChangeCommandRecords,
  hiddenOperationIds,
  previewWithoutOperations,
  readPreviewAfterChangeCommands,
  useChangeCommandRecords,
} from "./draft-command-record";
import { projectQueryKeys } from "./project-query-keys";
import { workDraftsQueryOptions } from "./useWorkDrafts";

export type DraftPreviewState = { preview: DraftPreviewResponse | null };

type DraftRef = { projectId: string; workId: string; documentId: string; draftId: string };

/**
 * The cache never goes back a generation: a read that began before a close can
 * land after the next proposal's, and the draft's generation only rises
 * (`ThreadDraftListItem.draftGeneration`). Anything else is the default
 * structural sharing, which keeps the reference when a refetch changed nothing.
 */
function keepNewerGeneration(prior: unknown, next: unknown): unknown {
  const before = prior as DraftPreviewResponse | undefined;
  const after = next as DraftPreviewResponse;
  if (
    before?.status === "active" &&
    after.status === "active" &&
    after.draftGeneration < before.draftGeneration
  )
    return before;
  return replaceEqualDeep(prior, next);
}

/** The one preview query, shared by every reader so each draft's preview is fetched once. */
export function draftPreviewQueryOptions(draft: DraftRef) {
  return {
    queryKey: projectQueryKeys.workDraftPreview(
      draft.projectId,
      draft.workId,
      draft.documentId,
      draft.draftId,
    ),
    queryFn: () =>
      readPreviewAfterChangeCommands(draft, () =>
        getDraftPreview(draft.projectId, draft.workId, draft.documentId, draft.draftId),
      ),
    staleTime: 15_000,
    structuralSharing: keepNewerGeneration,
  };
}

const withoutHidden = new WeakMap<
  DraftPreviewResponse,
  { hiddenKey: string; preview: DraftPreviewResponse }
>();

/**
 * The read minus the hidden operations, one object for every reader of it: a
 * reader's own copy would be a new preview each, and everything derived from a
 * preview (the changes list) would be derived once per reader.
 */
function previewWithoutHidden(
  data: DraftPreviewResponse,
  hidden: ReadonlySet<string>,
  hiddenKey: string,
): DraftPreviewResponse {
  const held = withoutHidden.get(data);
  if (held?.hiddenKey === hiddenKey) return held.preview;
  const preview = previewWithoutOperations(data, hidden);
  withoutHidden.set(data, { hiddenKey, preview });
  return preview;
}

/** The operations the command records hide from this draft's preview, and a key that names them. */
function hiddenOf(records: ChangeCommandRecords, draft: DraftRef) {
  const hidden = hiddenOperationIds(records, draft);
  return { hidden, hiddenKey: [...hidden].sort().join(",") };
}

export function useDraftPreview(
  projectId: string | null,
  workId: string | null,
  documentId: string | null,
  draftId: string | null,
  options?: { enabled?: boolean },
): DraftPreviewState {
  const callerEnabled = options?.enabled ?? true;
  const enabled =
    callerEnabled &&
    Boolean(projectId) &&
    Boolean(workId) &&
    Boolean(documentId) &&
    Boolean(draftId);
  const draft = {
    projectId: projectId ?? "",
    workId: workId ?? "",
    documentId: documentId ?? "",
    draftId: draftId ?? "",
  };
  const { data } = useQuery({
    ...draftPreviewQueryOptions(draft),
    enabled,
  });

  // Keyed by the hidden operations themselves, so unrelated command records
  // never hand consumers a new preview object (the editor re-paints on one).
  const records = useChangeCommandRecords();
  const { hidden, hiddenKey } = hiddenOf(records, draft);
  const preview = useMemo(
    () => (data ? previewWithoutHidden(data, hidden, hiddenKey) : null),
    [data, hiddenKey],
  );

  return { preview };
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
  return `${draft.projectId}\u0000${draft.workId}\u0000${draft.documentId}\u0000${draft.draftId}`;
}

/**
 * The `updatedAt` each target's draft carries in its Work's draft list (the
 * list the catalog wake re-reads), or undefined while the list or the row is
 * not there. Reads the shared list query, so it costs no extra fetch.
 */
function useDraftListRows(targets: readonly DraftRef[]): (string | undefined)[] {
  const scopes = [...new Map(targets.map((t) => [`${t.projectId}\u0000${t.workId}`, t])).values()];
  const lists = useQueries({
    queries: scopes.map(({ projectId, workId }) => workDraftsQueryOptions(projectId, workId)),
    combine: useCallback(
      (all: { data?: { draftId: string; updatedAt: string }[] }[]) =>
        all.map(({ data }) =>
          data?.map(({ draftId, updatedAt }) => `${draftId}\u0000${updatedAt}`),
        ),
      [],
    ),
  });
  return targets.map((target) => {
    const at = scopes.findIndex(
      (scope) => scope.projectId === target.projectId && scope.workId === target.workId,
    );
    const prefix = `${target.draftId}\u0000`;
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
  options?: { openReview?: { documentId: string; draftId: string } | null },
): readonly DraftPreviewEntry[] {
  const queryClient = useQueryClient();
  const records = useChangeCommandRecords();
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
      const isOpen = open?.documentId === target.documentId && open.draftId === target.draftId;
      if (prior === undefined || prior === updatedAt || isOpen) return;
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workDraftPreview(
          target.projectId,
          target.workId,
          target.documentId,
          target.draftId,
        ),
      });
    });
    for (const key of seen.current.keys()) if (!held.has(key)) seen.current.delete(key);
  }, [targetsKey, listedKey, open?.documentId, open?.draftId, queryClient]);

  const hiddenKeys = targets.map((target) => hiddenOf(records, target).hiddenKey).join("|");
  return useMemo(() => {
    if (targets.length === 0) return NO_ENTRIES;
    return reads.map(({ data, failed, retry }, index): DraftPreviewEntry => {
      if (data) {
        const { hidden, hiddenKey } = hiddenOf(records, targets[index]);
        return { status: "ready", preview: previewWithoutHidden(data, hidden, hiddenKey) };
      }
      return failed ? { status: "error", retry } : { status: "loading" };
    });
  }, [reads, hiddenKeys, targetsKey]);
}
