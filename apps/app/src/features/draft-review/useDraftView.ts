/** Bind a listed draft's domain view to its caller's Work authority, without joining a room. */

import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import {
  type DraftRef,
  useChangeCommandRecords,
  wholeDraftDisposition,
  wholeDraftPending,
} from "@/client/query/draft-command-record";
import { useDraftPreviews } from "@/client/query/useDraftPreview";
import { usePresentedDraftReview } from "./DraftReviewProvider";
import {
  type DraftChangesData,
  type DraftChangesView,
  listablePreview,
  useChangeItems,
} from "./draft-changes";
import { type ReviewChange, reviewChangesOfPreview, wholeItemChange } from "./review-changes";
import { useOpenReviewChanges } from "./useOpenReviewChanges";
import type { WorkDraftCommands } from "./useWorkDraftCommands";

const EMPTY: readonly ReviewChange[] = [];

/** Share a painted review's continuity, never borrow its command authority. */
export function useDraftView(
  draft: DraftRef,
  {
    controller,
    enabled = true,
    item,
  }: {
    controller: Pick<WorkDraftCommands, "commandChange" | "changesLocked">;
    enabled?: boolean;
    item?: ThreadDraftListItem;
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
    open.itemKey === draft.itemKey;
  const painted = useOpenReviewChanges(presented, { enabled: sharing });
  const branchless = item?.branchGeneration === null;
  const entry = useDraftPreviews(enabled && !sharing && !branchless ? [draft] : [], {
    openReview: open,
  })[0];
  const preview = entry?.status === "ready" ? listablePreview(entry.preview) : null;
  const { items, hiding } = useChangeItems(
    draft,
    branchless && item && enabled
      ? wholeDraftDisposition(records, draft, undefined, item) === null
        ? [wholeItemChange(item)]
        : EMPTY
      : preview
        ? reviewChangesOfPreview(preview)
        : EMPTY,
  );
  const status =
    branchless && enabled
      ? "ready"
      : !entry
        ? "idle"
        : entry.status === "error" ||
            (entry.status === "ready" && entry.preview.status === "corrupt")
          ? "error"
          : preview
            ? "ready"
            : entry.status === "ready" && entry.preview.status === "gone"
              ? "gone"
              : "loading";
  const data: DraftChangesData = sharing
    ? {
        documentId: painted.documentId,
        itemKey: painted.itemKey,
        status: painted.status,
        items: painted.items,
        unlisted: painted.unlisted,
      }
    : {
        documentId: draft.documentId,
        itemKey: draft.itemKey,
        status,
        items: status === "ready" ? items : [],
        unlisted: !branchless && status === "ready" && items.length === 0 && !hiding,
        ...(entry?.status === "error" ? { retry: entry.retry } : {}),
      };
  return {
    ...data,
    focused: null,
    locked,
    apply: async (change) => {
      await controller.commandChange("apply", draft, change.target);
    },
    discard: async (change) => {
      await controller.commandChange("discard", draft, change.target);
    },
  };
}
