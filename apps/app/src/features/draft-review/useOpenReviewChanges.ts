/** Retained, projected open-review presentation data, without focus or command bindings. */
import { useMemo, useRef } from "react";
import { intentKeys, useChangeCommandRecords } from "@/client/query/branch-command-record";
import { type ActivePreview, previewWithoutKeys } from "@/client/query/draft-projection";
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
  // A surface outside the open review reads nothing.
  const inline = options?.enabled === false ? null : controller.inlineReview;
  const documentId = inline?.documentId ?? null;
  const itemKey = inline?.itemKey ?? null;
  const { preview, observed } = useDraftPreview(
    controller.projectId,
    controller.workId,
    documentId,
    itemKey,
    {
      enabled: inline !== null,
    },
  );
  const active = listablePreview(preview);
  // The review lists the changes of the generation it shows. A preview of
  // another one is the next proposal on its way in (the review re-enters it) or
  // the close's own reset: it is not this review's to list.
  const shown = inline?.draftGeneration;
  const own =
    active && (shown === undefined || active.draftGeneration === shown)
      ? reviewChangesOfPreview(active)
      : null;
  // While the review and its preview disagree about the generation (the next
  // one is arriving, or the cache lags behind it), the draft's last observation
  // of the generation the writer was acting on stays, projected under the
  // intents as they are now: its rows keep taking clicks, and a click already
  // made is not in it. Each click is resolved against the draft as it is when it
  // is sent. Only the draft's own earlier observation is kept, never another's.
  const held = useRef<{ itemKey: string | null; observed: ActivePreview | null }>({
    itemKey: null,
    observed: null,
  });
  if (own && observed?.status === "active") held.current = { itemKey, observed };
  const records = useChangeCommandRecords();
  const heldObserved = held.current.itemKey === itemKey ? held.current.observed : null;
  const hiddenKey = itemKey
    ? [
        ...intentKeys(records, {
          projectId: controller.projectId,
          workId: controller.workId,
          documentId: documentId ?? "",
          itemKey,
        }).hidden,
      ]
        .sort()
        .join(",")
    : "";
  const heldChanges = useMemo(() => {
    if (!heldObserved) return NO_CHANGES;
    const hidden = new Set(hiddenKey ? hiddenKey.split(",") : []);
    const projected = previewWithoutKeys(heldObserved, hidden);
    return projected.status === "active" ? reviewChangesOfPreview(projected) : NO_CHANGES;
  }, [heldObserved, hiddenKey]);
  // A newer preview with nothing to review is the close's own reset: that is not held.
  const keeping =
    own === null &&
    active !== null &&
    heldObserved !== null &&
    shown !== undefined &&
    (active.draftGeneration < shown || reviewChangesOfPreview(active).length > 0);
  const changes = own ?? (keeping ? heldChanges : NO_CHANGES);
  const settling = keeping && changes.length > 0;
  const draftRef = useMemo(
    () =>
      documentId && itemKey
        ? { projectId: controller.projectId, workId: controller.workId, documentId, itemKey }
        : null,
    [controller.projectId, controller.workId, documentId, itemKey],
  );
  const { items, hiding } = useChangeItems(draftRef, changes);
  const completion = inline?.completion;
  const completing = completion?.phase === "pending" ? completion.mode : null;
  const status: DraftChangesData["status"] = !inline
    ? "idle"
    : active
      ? adoptsGeneration(inline, {
          draftGeneration: active.draftGeneration,
          proposal: reviewChangesOfPreview(active).length > 0,
        }) && !settling
        ? "loading"
        : "ready"
      : preview?.status === "corrupt"
        ? "error"
        : preview?.status === "gone"
          ? "gone"
          : "loading";
  const finished = completion?.phase === "closed";
  const unlisted =
    !finished && status === "ready" && completing === null && items.length === 0 && !hiding;
  return {
    inline,
    documentId,
    itemKey,
    preview,
    active,
    changes,
    settling,
    status,
    items: finished ? NO_ITEMS : items,
    unlisted,
    completing,
    finished,
  };
}
