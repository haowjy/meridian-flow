/** Owns inline-review restoration and the draft identity on an Editor address. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect, useRef } from "react";
import type { DraftReviewContextValue } from "@/features/draft-review/DraftReviewProvider";
import type { ScreenKey } from "../shell/screens";
import { useOpenEditorReview, usePendingEditorReviewDraftId } from "./editor-review-handoff";
import { useReviewHandoverRelease } from "./review-handover";

export function EditorReviewAddressOwner({
  review,
  requestedDraftId,
  activeScreen,
  activeScheme,
  activePath,
  activeDocumentId,
  onSetDraftId,
}: {
  review: DraftReviewContextValue;
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
  // The route is the destination a held review waits for; this owner is mounted
  // whatever page is, so it is where a hold learns the destination changed.
  useReviewHandoverRelease(review, {
    screen: activeScreen,
    scheme: activeScheme,
    documentId: activeDocumentId,
  });
  const pendingDraftId = usePendingEditorReviewDraftId();
  const restoring = useRef<string | null>(null);
  const ownedReview = useRef(false);
  const addressNames = (
    documentId: string,
    contextPath: string | null | undefined,
  ): "yes" | "no" | "pending" => {
    if (activeDocumentId) return activeDocumentId === documentId ? "yes" : "no";
    return contextPath === activePath ? "yes" : "pending";
  };

  useEffect(() => {
    const inline = review.controller.inlineReview;
    if (inline) {
      ownedReview.current = true;
      restoring.current = null;
      const group = review.groupForDocument(inline.documentId);
      // A review the writer finished holds on its own: the server closed its
      // draft, so the list no longer names the document, and only the address
      // can say the writer left.
      const match = group
        ? addressNames(inline.documentId, group.contextPath)
        : inline.completion
          ? addressNames(inline.documentId, undefined)
          : "no";
      if (activeScreen !== "context" || activeScheme !== "manuscript" || match === "no") {
        review.controller.exitInlineReview();
        return;
      }
      // The address is still resolving: keep the review, and its query, until it decides.
      if (match === "pending") return;
      // The route command already carries this identity. Let it settle instead
      // of competing with itself through an address-owner replacement.
      if (pendingDraftId === inline.draftId) return;
      if (requestedDraftId !== inline.draftId) onSetDraftId(inline.draftId);
      return;
    }
    if (ownedReview.current) {
      ownedReview.current = false;
      restoring.current = null;
      if (requestedDraftId) onSetDraftId(null);
      return;
    }
    if (!requestedDraftId) {
      restoring.current = null;
      return;
    }
    if (activeScreen !== "context" || activeScheme !== "manuscript") {
      restoring.current = null;
      onSetDraftId(null);
      return;
    }
    if (pendingDraftId === requestedDraftId) return;
    if (review.drafts.status !== "ready" && review.drafts.status !== "empty") return;
    const group = review.groups.find((candidate) => candidate.draft.draftId === requestedDraftId);
    const draft = group?.draft.draftId === requestedDraftId ? group.draft : null;
    const match =
      group?.contextPath && draft ? addressNames(group.documentId, group.contextPath) : "no";
    if (match === "no") {
      restoring.current = null;
      onSetDraftId(null);
      return;
    }
    if (match === "pending" || !group?.contextPath || !draft) return;
    if (restoring.current === requestedDraftId) return;
    restoring.current = requestedDraftId;
    void openReview({
      workId: review.controller.workId,
      documentId: group.documentId,
      draftId: requestedDraftId,
      contextPath: group.contextPath,
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
  ]);

  return null;
}
