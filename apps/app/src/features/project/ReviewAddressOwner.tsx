/** Owns inline-review restoration and the Work/item selection on the presenting container's address. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect, useRef } from "react";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import {
  type AiDraftLaunchTarget,
  usePendingEditorReviewItemKey,
} from "./dock/editor-review-handoff";
import type {
  PresentedDocument,
  ReviewAddress,
  ReviewAddressAdmission,
} from "./presented-document";

export type ReviewAddressPort = {
  write(review: ReviewAddress | null): void;
  admit(target: AiDraftLaunchTarget): void | Promise<void>;
};

type ReviewLocator = { scheme: ProjectContextTreeScheme; path: string };

/** The review the owner last confirmed on the address, kept to recognise its own Exit. */
type OwnedReview = {
  container: PresentedDocument["container"];
  workId: string;
  itemKey: string;
  documentId: string;
  /** Confirmed by identity or the review's location, never a pending rename guess. */
  locator: ReviewLocator | null;
};

/**
 * Only the teardown of the review still named by the address may consume its request. A known
 * document identity decides; while it is unresolved only the exact confirmed locator does.
 * Another container, Work or item is never consumed.
 */
export function exitedReviewOwnsAddress(
  owned: OwnedReview,
  address: {
    container: PresentedDocument["container"];
    workId: string;
    itemKey?: string;
    documentId?: string | null;
    locator: ReviewLocator | null;
  },
): boolean {
  if (
    !address.itemKey ||
    owned.container !== address.container ||
    owned.workId !== address.workId ||
    owned.itemKey !== address.itemKey
  )
    return false;
  if (address.documentId) return owned.documentId === address.documentId;
  return (
    !!owned.locator &&
    !!address.locator &&
    owned.locator.scheme === address.locator.scheme &&
    owned.locator.path === address.locator.path
  );
}

function locatorOf(presented: PresentedDocument): ReviewLocator | null {
  return presented.scheme && presented.path
    ? { scheme: presented.scheme, path: presented.path }
    : null;
}

export function ReviewAddressOwner({
  review,
  presented,
  admission,
  port,
}: {
  review: DraftReviewContextValue;
  presented: PresentedDocument | null;
  /** The route's verdict on the Editor's explicit selector; the dock restores through its own port. */
  admission: ReviewAddressAdmission;
  port: ReviewAddressPort;
}) {
  const pendingItemKey = usePendingEditorReviewItemKey();
  const restoring = useRef<string | null>(null);
  const ownedReview = useRef<OwnedReview | null>(null);
  const requestedItemKey = presented?.review?.itemKey;
  const write = (address: ReviewAddress | null) => {
    if (!address && presented?.draftOnly) return;
    port.write(address);
  };
  // Missing metadata (a list still loading) is "pending", never a mismatch.
  const addressNames = (
    documentId: string,
    location: ReviewLocator | null | undefined,
  ): "yes" | "no" | "pending" => {
    if (presented?.documentId) return presented.documentId === documentId ? "yes" : "no";
    return location && location.scheme === presented?.scheme && location.path === presented?.path
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
      const file = review.fileForDocument(inline.documentId);
      const match =
        presented?.documentId && presented.documentId !== inline.documentId
          ? "no"
          : file
            ? addressNames(inline.documentId, file.contextLocation)
            : "pending";
      // An inline review that lags a warm change of Work or item yields to the
      // address; it never relabels a newer request with its own identity.
      if (
        !presented ||
        match === "no" ||
        (presented.review &&
          (presented.review.workId !== review.controller.workId ||
            presented.review.itemKey !== inline.itemKey))
      ) {
        review.controller.exitInlineReview();
        return;
      }
      // The address is still resolving: keep the review, and its query, until it decides.
      if (match === "pending" || admission !== "admitted") return;
      // The route command already carries this identity. Let it settle instead
      // of competing with itself through an address-owner replacement.
      ownedReview.current = {
        container: presented.container,
        workId: review.controller.workId,
        itemKey: inline.itemKey,
        documentId: inline.documentId,
        locator: locatorOf(presented),
      };
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
      if (
        presented?.review &&
        exitedReviewOwnsAddress(owned, {
          container: presented.container,
          workId: presented.review.workId,
          itemKey: presented.review.itemKey,
          documentId: presented.documentId,
          locator: locatorOf(presented),
        })
      ) {
        write(null);
        return;
      }
    }
    if (!presented?.review || !requestedItemKey) {
      restoring.current = null;
      return;
    }
    if (admission !== "admitted") return;
    if (presented.container === "dock") {
      if (
        !presented.documentId ||
        !presented.path ||
        !presented.scheme ||
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
    // Only the route's server answer admits an Editor selector. Pending, failed and
    // unavailable leave it as written: the pane says why, the live occupant never stands in.
    if (admission !== "admitted") return;
    if (pendingItemKey === requestedItemKey || restoring.current === requestedItemKey) return;
    if (
      !presented.documentId ||
      !presented.scheme ||
      !presented.path ||
      review.controller.workId !== presented.review.workId
    )
      return;
    // The list, when loaded, supplies labels and whole-item state; it is never an authority.
    const file = review.files.find((candidate) => candidate.draft.itemKey === requestedItemKey);
    restoring.current = requestedItemKey;
    void Promise.resolve(
      port.admit({
        workId: presented.review.workId,
        documentId: presented.documentId,
        itemKey: requestedItemKey,
        contextLocation: { scheme: presented.scheme, path: presented.path },
        documentName: file?.documentName ?? undefined,
        isNew: file?.isNew ?? presented.draftOnly,
      }),
    ).catch((error) => {
      restoring.current = null;
      console.error("[review] address restore failed", error);
    });
  }, [presented, port, pendingItemKey, requestedItemKey, review, admission]);

  return null;
}
