/** Owns inline-review restoration and the draft identity on the presenting container address. */
import { useEffect, useRef } from "react";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import {
  type AiDraftLaunchTarget,
  usePendingEditorReviewDraftId,
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
  const pendingDraftId = usePendingEditorReviewDraftId();
  const restoring = useRef<string | null>(null);
  const ownedReview = useRef<PresentedDocument | null>(null);
  const requestedDraftId = presented?.review?.draftId;
  const write = (address: ReviewAddress | null) => {
    if (!address && presented?.draftOnly) return;
    port.write(address);
  };
  const addressNames = (
    documentId: string,
    contextPath: string | null | undefined,
  ): "yes" | "no" | "pending" => {
    if (presented?.documentId) return presented.documentId === documentId ? "yes" : "no";
    return contextPath === presented?.path ? "yes" : "pending";
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
        review.fileForDocument(inline.documentId)?.contextPath,
      );
      if (
        presented?.scheme !== "manuscript" ||
        match === "no" ||
        (presented.review &&
          (presented.review.workId !== review.controller.workId ||
            (presented.container === "dock" && presented.review.draftId !== inline.draftId)))
      ) {
        review.controller.exitInlineReview();
        return;
      }
      // The address is still resolving: keep the review, and its query, until it decides.
      if (match === "pending") return;
      // The route command already carries this identity. Let it settle instead
      // of competing with itself through an address-owner replacement.
      ownedReview.current = presented;
      if (presented.container === "editor" && pendingDraftId === inline.draftId) return;
      if (requestedDraftId !== inline.draftId)
        write({ workId: review.controller.workId, draftId: inline.draftId });
      return;
    }
    if (ownedReview.current) {
      const owned = ownedReview.current;
      ownedReview.current = null;
      restoring.current = null;
      // An exit for a different scope/document must not erase its destination.
      if (
        requestedDraftId &&
        owned.container === presented?.container &&
        owned.documentId === presented.documentId &&
        owned.review?.workId === presented.review?.workId &&
        owned.review?.draftId === presented.review?.draftId
      ) {
        write(null);
        return;
      }
    }
    if (!requestedDraftId) {
      restoring.current = null;
      return;
    }
    if (!presented || presented.scheme !== "manuscript") {
      restoring.current = null;
      write(null);
      return;
    }
    if (presented.container === "dock") {
      if (
        !presented.documentId ||
        !presented.path ||
        !presented.review ||
        review.controller.workId !== presented.review.workId ||
        restoring.current === requestedDraftId
      )
        return;
      restoring.current = requestedDraftId;
      void port.admit({
        workId: presented.review.workId,
        documentId: presented.documentId,
        draftId: requestedDraftId,
        contextPath: presented.path,
        isNewDocument: presented.draftOnly,
      });
      return;
    }
    if (pendingDraftId === requestedDraftId) return;
    if (review.drafts.status !== "ready" && review.drafts.status !== "empty") return;
    const group = review.files.find((candidate) => candidate.draft.draftId === requestedDraftId);
    const draft = group?.draft.draftId === requestedDraftId ? group.draft : null;
    const match =
      group?.contextPath && draft ? addressNames(group.documentId, group.contextPath) : "no";
    if (match === "no") {
      restoring.current = null;
      write(null);
      return;
    }
    if (match === "pending" || !group?.contextPath || !draft) return;
    if (restoring.current === requestedDraftId) return;
    restoring.current = requestedDraftId;
    void Promise.resolve(
      port.admit({
        workId: review.controller.workId,
        documentId: group.documentId,
        draftId: requestedDraftId,
        contextPath: group.contextPath,
        documentName: group.documentName ?? undefined,
        isNewDocument: draft.isNewDocument === true,
      }),
    ).catch((error) => {
      restoring.current = null;
      console.error("[review] address restore failed", error);
    });
  }, [presented, port, pendingDraftId, requestedDraftId, review]);

  return null;
}
