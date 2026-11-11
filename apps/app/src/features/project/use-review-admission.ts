/**
 * Makes a document host's review controller follow what the document paints: the paint says which
 * draft it shows (`useDocumentPaint`), and the controller enters, keeps or leaves it to match. The
 * focused change is kept in step both ways: a change the writer focuses is recorded on the view's
 * pin so a review link can name it, and a pin that moves on its own (a reload, a shared link,
 * Back, a launch that names a change) focuses the change it names.
 */
import { useEffect, useRef } from "react";
import type { DraftPin } from "@/client/project-shell/document-views";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import { useOpenReviewChanges } from "@/features/draft-review/useOpenReviewChanges";
import type { AiDraftLaunchTarget } from "./review-launch";

/** The route's verdict on a review the address names, asked of the server by owner and item. */
export type ReviewAddressAdmission = "pending" | "admitted" | "unavailable" | "failed";

export type ReviewAdmissionPort = {
  /** Records the focused change on the view's pin. */
  write(review: DraftPin): void;
  /** `false`: refused, because the item's known draft is closed and no newer one replaced it. */
  admit(target: AiDraftLaunchTarget): Promise<boolean>;
};

export type ReviewedDocument = {
  documentId: string;
  scheme: AiDraftLaunchTarget["contextLocation"]["scheme"] | null;
  path: string | null;
  /** The draft the document paints; null on Live or while the paint is held. */
  review: DraftPin | null;
  /** The view asks for a draft: an open review of the document stays until the writer picks Live. */
  draftView: boolean;
};

export function useReviewAdmission({
  review,
  presented,
  admission,
  port,
}: {
  review: DraftReviewContextValue;
  presented: ReviewedDocument | null;
  /** The route's verdict when the address names this review; "admitted" for every other review. */
  admission: ReviewAddressAdmission;
  port: ReviewAdmissionPort;
}) {
  /** The item an admission is in flight for. */
  const restoring = useRef<string | null>(null);
  /**
   * The port that refused the request. Admitting the same item through it again would be
   * refused again; a new port (a newer draft generation) gets one try.
   */
  const refused = useRef<{ itemKey: string; port: ReviewAdmissionPort } | null>(null);
  /** The focus and the pin's change as last reconciled: whichever differs from it is what moved. */
  const settled = useRef<{ focus?: string; pin?: string }>({});
  const { changes, status } = useOpenReviewChanges(review.controller);
  const requested = presented?.review ?? null;

  useEffect(() => {
    const inline = review.controller.inlineReview;
    if (inline) {
      restoring.current = null;
      if (requested === null && presented?.draftView && presented.documentId === inline.documentId)
        return;
      const names =
        requested !== null &&
        presented?.documentId === inline.documentId &&
        requested.ownerKey === review.controller.ownerKey &&
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
          port.write({
            ownerKey: requested.ownerKey,
            itemKey: requested.itemKey,
            changeId: focusId,
          });
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
    if (admission !== "admitted" || review.controller.ownerKey !== requested.ownerKey) return;
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
        ownerKey: requested.ownerKey,
        documentId: presented.documentId,
        itemKey,
        contextLocation: { scheme: presented.scheme, path: presented.path },
        documentName: file?.documentName ?? undefined,
      })
      .then(
        (admitted) => {
          if (restoring.current !== itemKey) return;
          restoring.current = null;
          if (!admitted) refused.current = { itemKey, port };
        },
        (error) => {
          if (restoring.current === itemKey) restoring.current = null;
          console.error("[review] address restore failed", error);
        },
      );
  }, [presented, port, requested, review, admission, changes, status]);
}
