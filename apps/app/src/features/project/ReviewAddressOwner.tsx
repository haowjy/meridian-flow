/**
 * Makes the review controller follow the selected tab: the tab says which review it paints
 * (`presented.review`, resolved from its view, the Work scope and an optional pin), and the
 * controller enters, keeps or leaves it to match. The focused change is kept in step both ways:
 * a change the writer focuses is recorded on the pin so a review link can name it, and a pin that
 * moves on its own (a reload, a shared link, Back) focuses the change it names.
 */
import { useEffect, useRef } from "react";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import { useOpenReviewChanges } from "@/features/draft-review/useOpenReviewChanges";
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
  /** The focus and the pin's change as last reconciled: whichever differs from it is what moved. */
  const settled = useRef<{ focus?: string; pin?: string }>({});
  const { changes, status } = useOpenReviewChanges(review.controller);
  const requested = presented?.review ?? null;
  const requestedWorkId = requested ? reviewAddressWorkId(requested) : null;

  useEffect(() => {
    const inline = review.controller.inlineReview;
    if (inline) {
      restoring.current = null;
      if (requested === null && presented?.draftView && presented.documentId === inline.documentId)
        return;
      const names =
        requested !== null &&
        presented?.documentId === inline.documentId &&
        requestedWorkId === review.controller.workId &&
        requested.itemKey === inline.itemKey;
      if (!names) {
        settled.current = {};
        review.controller.exitInlineReview();
        return;
      }
      const focusId = review.controller.focus?.id;
      if (focusId !== settled.current.focus) {
        settled.current = { focus: focusId, pin: requested.changeId };
        if (focusId && admission === "admitted" && requested.changeId !== focusId) {
          settled.current.pin = focusId;
          port.write(reviewAddress(requestedWorkId as string, requested.itemKey, focusId));
        }
        return;
      }
      if (requested.changeId === settled.current.pin) return;
      // Until the review has painted and its changes are read, the controller's default (the
      // first change) would stand in for the one the pin names.
      if (!inline.shown || status !== "ready") return;
      settled.current.pin = requested.changeId;
      // A change that is gone (applied, discarded, regrouped) leaves the first, which then
      // replaces the stale id on the pin.
      const change = changes.find((candidate) => candidate.id === requested.changeId) ?? changes[0];
      if (change)
        review.controller.focusReviewChange(
          { documentId: inline.documentId, itemKey: inline.itemKey },
          change,
          { scroll: true },
        );
      return;
    }
    settled.current = {};
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
  }, [presented, port, requested, review, admission, changes, status]);

  return null;
}
