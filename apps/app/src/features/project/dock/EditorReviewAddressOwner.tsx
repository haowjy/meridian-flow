/** Owns inline-review restoration and the draft identity on an Editor address. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect, useRef } from "react";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import type { DraftReviewContextValue } from "@/features/chat/DraftReviewProvider";
import type { ScreenKey } from "../shell/screens";
import { useOpenEditorReview, usePendingEditorReviewDraftId } from "./editor-review-handoff";
import { exitedReviewOwnsAddress, type OwnedReviewAddress } from "./review-address-ownership";

export function EditorReviewAddressOwner({
  review,
  reviewAddressAdmission,
  requestedDraftId,
  activeScreen,
  activeScheme,
  activePath,
  activeDocumentId,
  onSetDraftId,
}: {
  review: DraftReviewContextValue;
  reviewAddressAdmission: "pending" | "admitted" | "unavailable" | "failed";
  requestedDraftId?: string;
  activeScreen: ScreenKey;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  /**
   * The document the address resolved to, absent while it is still resolving. A
   * review follows its document through a rename or move, so identity decides
   * once known. Until then the path can only confirm a match: a different path
   * is not evidence of a different document, so the request waits.
   */
  activeDocumentId?: string | null;
  onSetDraftId: (draftId: string | null) => void;
}) {
  const openReview = useOpenEditorReview();
  const pendingDraftId = usePendingEditorReviewDraftId();
  const restoring = useRef<string | null>(null);
  const ownedReview = useRef<OwnedReviewAddress | null>(null);
  const addressNames = (
    documentId: string,
    contextLocation: ThreadDraftGroup["contextLocation"] | undefined,
  ): "yes" | "no" | "pending" => {
    if (activeDocumentId) return activeDocumentId === documentId ? "yes" : "no";
    return contextLocation?.scheme === activeScheme && contextLocation?.path === activePath
      ? "yes"
      : "pending";
  };

  useEffect(() => {
    const inline = review.controller.inlineReview;
    if (inline) {
      restoring.current = null;
      const group = review.groupForDocument(inline.documentId);
      // Inline state may lag a warm destination change by one render. Never
      // relabel its provenance or repair over an explicitly different request.
      if (
        (requestedDraftId && requestedDraftId !== inline.draftId) ||
        group?.draft.draftId !== inline.draftId ||
        (ownedReview.current && ownedReview.current.workId !== review.controller.workId)
      ) {
        review.controller.exitInlineReview();
        return;
      }
      const match = group ? addressNames(inline.documentId, group.contextLocation) : "no";
      if (activeScreen !== "context" || !activeScheme || match === "no") {
        review.controller.exitInlineReview();
        return;
      }
      // The address is still resolving: keep the review, and its query, until it decides.
      if (match === "pending") return;
      // The route command already carries this identity. Let it settle instead
      // of competing with itself through an address-owner replacement.
      ownedReview.current = {
        workId: review.controller.workId,
        ...inline,
        locator: activeScheme && activePath ? { scheme: activeScheme, path: activePath } : null,
      };
      if (pendingDraftId === inline.draftId) return;
      if (requestedDraftId !== inline.draftId) onSetDraftId(inline.draftId);
      return;
    }
    if (ownedReview.current) {
      const owned = ownedReview.current;
      ownedReview.current = null;
      restoring.current = null;
      // Exiting the previous review cannot consume a different destination's request.
      if (
        exitedReviewOwnsAddress(owned, {
          workId: review.controller.workId,
          documentId: activeDocumentId,
          draftId: requestedDraftId,
          locator: activeScheme && activePath ? { scheme: activeScheme, path: activePath } : null,
        })
      ) {
        onSetDraftId(null);
        return;
      }
    }
    if (!requestedDraftId) {
      restoring.current = null;
      return;
    }
    if (activeScreen !== "context" || !activeScheme) {
      restoring.current = null;
      onSetDraftId(null);
      return;
    }
    if (pendingDraftId === requestedDraftId) return;
    // Only the route admits review identity; missing presentation metadata cannot consume intent.
    if (reviewAddressAdmission !== "admitted") return;
    if (review.drafts.status !== "ready" && review.drafts.status !== "empty") return;
    const group = review.groups.find((candidate) => candidate.draft.draftId === requestedDraftId);
    const draft = group?.draft.draftId === requestedDraftId ? group.draft : null;
    const match =
      group?.contextLocation && draft
        ? addressNames(group.documentId, group.contextLocation)
        : "no";
    if (match === "no") {
      restoring.current = null;
      return;
    }
    if (match === "pending" || !group?.contextLocation || !draft) return;
    if (restoring.current === requestedDraftId) return;
    restoring.current = requestedDraftId;
    void openReview({
      workId: review.controller.workId,
      documentId: group.documentId,
      draftId: requestedDraftId,
      contextLocation: group.contextLocation,
      documentName: group.documentName ?? undefined,
      isNewDocument: draft.isNewDocument === true,
    }).catch((error) => {
      restoring.current = null;
      console.error("[editor-review] address restore failed", error);
    });
  }, [
    activeDocumentId,
    activePath,
    activeScheme,
    activeScreen,
    onSetDraftId,
    openReview,
    pendingDraftId,
    requestedDraftId,
    review,
    reviewAddressAdmission,
  ]);

  return null;
}
