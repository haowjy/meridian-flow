/**
 * Makes the review controller follow the selected tab: the tab says which review it paints
 * (`presented.review`, resolved from its view, the Work scope and an optional pin), and the
 * controller enters, keeps or leaves it to match. The one thing that flows the other way is the
 * focused change, which the pin records so a review link can name it.
 */
import { useEffect, useRef } from "react";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import {
  type PresentedDocument,
  type ReviewAddress,
  type ReviewAddressAdmission,
  reviewAddress,
  reviewAddressWorkId,
} from "./presented-document";
import type { AiDraftLaunchTarget } from "./review-launch";

export type ReviewAddressPort = {
  /** Records the focused change on the tab's pin. */
  write(review: ReviewAddress): void;
  /** `false`: refused, because the item's known draft is closed and no newer one replaced it. */
  admit(target: AiDraftLaunchTarget): Promise<boolean>;
};

export function ReviewAddressOwner({
  review,
  presented,
  admission,
  port,
}: {
  review: DraftReviewContextValue;
  presented: PresentedDocument | null;
  /** The route's verdict on an explicit review selector in the address. */
  admission: ReviewAddressAdmission;
  port: ReviewAddressPort;
}) {
  const restoring = useRef<string | null>(null);
  /**
   * The port that refused the request. Admitting the same item through it again would be
   * refused again; a new port (a newer draft generation) gets one try.
   */
  const refused = useRef<{ itemKey: string; port: ReviewAddressPort } | null>(null);
  const requested = presented?.review ?? null;
  const requestedWorkId = requested ? reviewAddressWorkId(requested) : null;

  useEffect(() => {
    const inline = review.controller.inlineReview;
    if (inline) {
      restoring.current = null;
      const names =
        requested !== null &&
        presented?.documentId === inline.documentId &&
        requestedWorkId === review.controller.workId &&
        requested.itemKey === inline.itemKey;
      if (!names) {
        review.controller.exitInlineReview();
        return;
      }
      const changeId = review.controller.focus?.id;
      if (changeId && admission === "admitted" && requested.changeId !== changeId)
        port.write(reviewAddress(requestedWorkId as string, requested.itemKey, changeId));
      return;
    }
    if (!requested || !presented?.documentId || !presented.scheme || !presented.path) {
      restoring.current = null;
      refused.current = null;
      return;
    }
    if (
      admission !== "admitted" ||
      !requestedWorkId ||
      review.controller.workId !== requestedWorkId
    )
      return;
    const itemKey = requested.itemKey;
    if (
      restoring.current === itemKey ||
      (refused.current?.itemKey === itemKey && refused.current.port === port)
    )
      return;
    // The list, when loaded, supplies labels and whole-item state; it is never an authority.
    const file = review.files.find((candidate) => candidate.draft.itemKey === itemKey);
    restoring.current = itemKey;
    void port
      .admit({
        workId: requestedWorkId,
        documentId: presented.documentId,
        itemKey,
        contextLocation: { scheme: presented.scheme, path: presented.path },
        documentName: file?.documentName ?? undefined,
        draftOnly: file?.draftOnly ?? presented.draftOnly,
      })
      .then(
        (admitted) => {
          if (admitted || restoring.current !== itemKey) return;
          restoring.current = null;
          refused.current = { itemKey, port };
        },
        (error) => {
          if (restoring.current === itemKey) restoring.current = null;
          console.error("[review] address restore failed", error);
        },
      );
  }, [presented, port, requested, review, admission]);

  return null;
}
