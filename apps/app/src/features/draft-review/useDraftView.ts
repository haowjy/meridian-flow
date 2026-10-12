/** Bind a listed draft's domain view to its caller's Work authority, without joining a room. */

import {
  type DraftRef,
  useChangeCommandRecords,
  wholeDraftPending,
} from "@/client/query/draft-command-record";
import { useDraftPreviews } from "@/client/query/useDraftPreview";
import { usePresentedDraftReview } from "./DraftReviewProvider";
import { type DraftChangesView, listablePreview, useChangeItems } from "./draft-changes";
import { type ReviewChange, reviewChangesOfPreview } from "./review-changes";
import { useReviewChanges } from "./useReviewChanges";
import type { WorkDraftCommands } from "./useWorkDraftCommands";

const EMPTY: readonly ReviewChange[] = [];

/** Share a painted review's continuity, never borrow its command authority. */
export function useDraftView(
  draft: DraftRef,
  {
    controller,
    enabled = true,
  }: {
    controller: Pick<WorkDraftCommands, "commandChange" | "changesLocked">;
    enabled?: boolean;
  },
): DraftChangesView {
  const records = useChangeCommandRecords();
  const locked = controller.changesLocked || wholeDraftPending(records, draft);
  const presented = usePresentedDraftReview().controller;
  const open = presented.inlineReview;
  const sharing =
    enabled &&
    presented.projectId === draft.projectId &&
    presented.workId === draft.workId &&
    open?.documentId === draft.documentId &&
    open.draftId === draft.draftId;
  const painted = useReviewChanges(presented, { enabled: sharing });
  const entry = useDraftPreviews(enabled && !sharing ? [draft] : [], { openReview: open })[0];
  const preview = entry?.status === "ready" ? listablePreview(entry.preview) : null;
  const { items, hiding } = useChangeItems(
    draft,
    preview ? reviewChangesOfPreview(preview) : EMPTY,
  );
  const status = !entry
    ? "idle"
    : entry.status === "error" || (entry.status === "ready" && entry.preview.status === "corrupt")
      ? "error"
      : preview
        ? "ready"
        : entry.status === "ready" && entry.preview.status === "gone"
          ? "gone"
          : "loading";
  return {
    ...(sharing
      ? painted
      : {
          documentId: draft.documentId,
          draftId: draft.draftId,
          status,
          items: status === "ready" ? items : [],
          focused: null,
          unlisted: status === "ready" && items.length === 0 && !hiding,
          ...(entry?.status === "error" ? { retry: entry.retry } : {}),
        }),
    locked,
    apply: async (change) => {
      await controller.commandChange("apply", draft, change.target);
    },
    discard: async (change) => {
      await controller.commandChange("discard", draft, change.target);
    },
  };
}
