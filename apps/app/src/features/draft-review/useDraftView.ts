/** Bind a listed draft's domain view to its caller's Work authority, without joining a room. */

import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import type { DraftRef } from "./review-command-types";
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
import type { WorkBranchCommands } from "./useWorkBranchCommands";

const EMPTY: readonly ReviewChange[] = [];

/** Share a painted review's continuity, never borrow its command authority. */
export function useDraftView(
  draft: DraftRef,
  {
    controller,
    enabled = true,
    item,
  }: {
    controller: Pick<WorkBranchCommands, "commandChange" | "changesLocked">;
    enabled?: boolean;
    item?: ThreadDraftListItem;
  },
): DraftChangesView {
  const locked = controller.changesLocked;
  const presented = usePresentedDraftReview().controller;
  const open = presented.inlineReview;
  const sharing =
    enabled &&
    presented.projectId === draft.projectId &&
    presented.workId === draft.workId &&
    open?.documentId === draft.documentId &&
    open.itemKey === draft.itemKey;
  const painted = useOpenReviewChanges(presented, { enabled: sharing });
  const withoutDocumentDraft = item?.draftGeneration === null;
  const entry = useDraftPreviews(enabled && !sharing && !withoutDocumentDraft ? [draft] : [], {
    openReview: open,
  })[0];
  const preview = entry?.status === "ready" ? listablePreview(entry.preview) : null;
  const { items, hiding } = useChangeItems(
    draft,
    withoutDocumentDraft && item && enabled
      ? [wholeItemChange(item)]
      : preview
        ? reviewChangesOfPreview(preview)
        : EMPTY,
  );
  const status =
    withoutDocumentDraft && enabled
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
        unlisted: !withoutDocumentDraft && status === "ready" && items.length === 0 && !hiding,
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
