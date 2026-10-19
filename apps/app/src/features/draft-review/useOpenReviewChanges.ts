/** Retained, projected open-review presentation data, without focus or command bindings. */
import { useDraftPreview } from "@/client/query/useDraftPreview";
import {
  type DraftChangesData,
  listablePreview,
  type ReviewChangeItem,
  useChangeItems,
} from "./draft-changes";
import { adoptsGeneration } from "./draft-review-session";
import { type ReviewChange, reviewChangesOfPreview } from "./review-changes";
import type { DraftReviewController } from "./useDraftReviewController";

const NO_ITEMS: readonly ReviewChangeItem[] = [];
const NO_CHANGES: readonly ReviewChange[] = [];

/** The open review's draft and its changes, derived once per preview. */
export function useOpenReviewChanges(
  controller: Pick<DraftReviewController, "projectId" | "workId" | "inlineReview">,
  options?: { enabled?: boolean },
) {
  const inline = options?.enabled === false ? null : controller.inlineReview;
  const documentId = inline?.documentId ?? null;
  const itemKey = inline?.itemKey ?? null;
  const { preview } = useDraftPreview(
    controller.projectId,
    controller.workId,
    documentId,
    itemKey,
    { enabled: inline !== null },
  );
  const active = listablePreview(preview);
  const changes = active ? reviewChangesOfPreview(active) : NO_CHANGES;
  const { items } = useChangeItems(
    documentId && itemKey
      ? { projectId: controller.projectId, workId: controller.workId, documentId, itemKey }
      : null,
    changes,
  );
  const status: DraftChangesData["status"] = !inline
    ? "idle"
    : active
      ? "ready"
      : preview?.status === "gone"
        ? "gone"
        : preview?.status === "corrupt"
          ? "error"
          : "loading";
  return {
    inline,
    documentId,
    itemKey,
    preview,
    active,
    changes,
    settling: false,
    status,
    items,
    unlisted: status === "ready" && !items.length,
    completing: null,
    finished: false,
  };
}
