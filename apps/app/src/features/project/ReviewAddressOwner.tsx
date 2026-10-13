/** Owns inline-review restoration and the draft/selected-change identity on the presenting container address. */
import { useEffect, useRef } from "react";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import type { ContextUri } from "@/lib/context-uri";
import {
  type AiDraftLaunchTarget,
  usePendingEditorReviewItemKey,
} from "./dock/editor-review-handoff";
import type { PresentedDocument, ReviewAddress } from "./presented-document";

export type ReviewAddressPort = {
  write(review: ReviewAddress | null): void;
  admit(target: AiDraftLaunchTarget): void | Promise<void>;
};
export function ReviewAddressOwner({
  review,
  presented,
  port,
}: {
  review: DraftReviewContextValue;
  presented: PresentedDocument | null;
  port: ReviewAddressPort;
}) {
  const pendingItemKey = usePendingEditorReviewItemKey();
  const restoring = useRef<string | null>(null);
  const ownedReview = useRef<PresentedDocument | null>(null);
  const requestedItemKey = presented?.review?.itemKey;
  const write = (address: ReviewAddress | null) => {
    if (!address && presented?.draftOnly) return;
    port.write(address);
  };
  const addressNames = (
    documentId: string,
    contextLocation: Pick<ContextUri, "scheme" | "path"> | null | undefined,
  ): "yes" | "no" | "pending" => {
    if (presented?.documentId) return presented.documentId === documentId ? "yes" : "no";
    return contextLocation?.scheme === presented?.scheme &&
      contextLocation?.path === presented?.path
      ? "yes"
      : "pending";
  };

  useEffect(() => {
    const inline = review.controller.inlineReview;
    if (inline) {
      restoring.current = null;
      // Only the address says the writer left. Whether the draft is still in the
      // list is the review's own decision (row X): a list that lags behind a new
      // proposal must not end a review the reducer keeps.
      const match = addressNames(
        inline.documentId,
        review.fileForDocument(inline.documentId)?.contextLocation,
      );
      if (
        !presented ||
        match === "no" ||
        (presented.review &&
          (presented.review.workId !== review.controller.workId ||
            (presented.container === "dock" && presented.review.itemKey !== inline.itemKey)))
      ) {
        review.controller.exitInlineReview();
        return;
      }
      // The address is still resolving: keep the review, and its query, until it decides.
      if (match === "pending") return;
      // The route command already carries this identity. Let it settle instead
      // of competing with itself through an address-owner replacement.
      ownedReview.current = presented;
      if (presented.container === "editor" && pendingItemKey === inline.itemKey) return;
      const changeId = review.controller.focus?.classId;
      if (
        requestedItemKey !== inline.itemKey ||
        ((changeId || !presented.review?.changeId) && presented.review?.changeId !== changeId)
      )
        write({
          workId: review.controller.workId,
          itemKey: inline.itemKey,
          ...(changeId ? { changeId } : {}),
        });
      return;
    }
    if (ownedReview.current) {
      const owned = ownedReview.current;
      ownedReview.current = null;
      restoring.current = null;
      // An exit for a different scope/document must not erase its destination.
      if (
        requestedItemKey &&
        owned.container === presented?.container &&
        owned.documentId === presented.documentId &&
        owned.review?.workId === presented.review?.workId &&
        owned.review?.itemKey === presented.review?.itemKey
      ) {
        write(null);
        return;
      }
    }
    if (!requestedItemKey) {
      restoring.current = null;
      return;
    }
    if (!presented) {
      restoring.current = null;
      write(null);
      return;
    }
    if (presented.container === "dock") {
      if (
        !presented.documentId ||
        !presented.path ||
        !presented.scheme ||
        !presented.review ||
        review.controller.workId !== presented.review.workId ||
        restoring.current === requestedItemKey
      )
        return;
      restoring.current = requestedItemKey;
      void port.admit({
        workId: presented.review.workId,
        documentId: presented.documentId,
        itemKey: requestedItemKey,
        contextLocation: { scheme: presented.scheme, path: presented.path },
        isNew: presented.draftOnly,
      });
      return;
    }
    if (pendingItemKey === requestedItemKey) return;
    if (review.drafts.status !== "ready" && review.drafts.status !== "empty") return;
    const group = review.files.find((candidate) => candidate.draft.itemKey === requestedItemKey);
    const draft = group?.draft.itemKey === requestedItemKey ? group.draft : null;
    const match =
      group?.contextLocation && draft
        ? addressNames(group.documentId, group.contextLocation)
        : "no";
    if (match === "no") {
      restoring.current = null;
      write(null);
      return;
    }
    if (match === "pending" || !group?.contextLocation || !draft) return;
    if (restoring.current === requestedItemKey) return;
    restoring.current = requestedItemKey;
    void Promise.resolve(
      port.admit({
        workId: review.controller.workId,
        documentId: group.documentId,
        itemKey: requestedItemKey,
        contextLocation: group.contextLocation,
        documentName: group.documentName ?? undefined,
        isNew: draft.isNew === true,
      }),
    ).catch((error) => {
      restoring.current = null;
      console.error("[review] address restore failed", error);
    });
  }, [presented, port, pendingItemKey, requestedItemKey, review]);

  return null;
}
