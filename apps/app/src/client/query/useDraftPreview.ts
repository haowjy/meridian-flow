/**
 * useDraftPreview — live markdown plus active AI draft preview for a document.
 *
 * What it returns is what the writer is looking at: changes with an Apply or
 * Discard in flight or confirmed are already gone from it (optimistic), and a
 * read that started before such a command cannot bring them back
 * (`change-command-record`). Every consumer, the editor's marks included,
 * therefore agrees on which changes exist.
 */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getDraftPreview } from "@/client/api/drafts-api";
import {
  hiddenOperationIds,
  previewWithoutOperations,
  readPreviewAfterChangeCommands,
  useChangeCommandRecords,
} from "./change-command-record";
import { projectQueryKeys } from "./project-query-keys";

export type DraftPreviewState = {
  preview: DraftPreviewResponse | null;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
};

type DraftRef = { projectId: string; workId: string; documentId: string; draftId: string };

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
  };
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
  const { data, isError, isFetching, refetch } = useQuery({
    ...draftPreviewQueryOptions(draft),
    enabled,
  });

  // Keyed by the hidden operations themselves, so unrelated command records
  // never hand consumers a new preview object (the editor re-paints on one).
  const records = useChangeCommandRecords();
  const hidden = hiddenOperationIds(records, draft);
  const hiddenKey = [...hidden].sort().join(",");
  const preview = useMemo(
    () => (data ? previewWithoutOperations(data, hidden) : null),
    [data, hiddenKey],
  );

  return {
    preview,
    isError,
    isFetching,
    refetch: () => {
      void refetch();
    },
  };
}
