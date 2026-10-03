/** Owns inline-review restoration and the draft identity on an Editor address. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect, useRef } from "react";
import type { DraftReviewContextValue } from "@/features/chat/DraftReviewProvider";
import type { ScreenKey } from "../shell/screens";
import { useOpenEditorReview, usePendingEditorReviewDraftId } from "./editor-review-handoff";

export function EditorReviewAddressOwner({
  review,
  requestedDraftId,
  activeScreen,
  activeScheme,
  activePath,
  onSetDraftId,
}: {
  review: DraftReviewContextValue;
  requestedDraftId?: string;
  activeScreen: ScreenKey;
  activeScheme: ProjectContextTreeScheme | null;
  activePath: string | null;
  onSetDraftId: (draftId: string | null) => void;
}) {
  const openReview = useOpenEditorReview();
  const pendingDraftId = usePendingEditorReviewDraftId();
  const restoring = useRef<string | null>(null);
  const ownedReview = useRef(false);

  useEffect(() => {
    const inline = review.controller.inlineReview;
    if (inline) {
      ownedReview.current = true;
      restoring.current = null;
      const group = review.groupForDocument(inline.documentId);
      const ownsAddress =
        activeScreen === "context" &&
        activeScheme === "manuscript" &&
        group?.contextPath === activePath;
      if (!ownsAddress) {
        review.controller.exitInlineReview();
        return;
      }
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
    if (!group?.contextPath || !draft || group.contextPath !== activePath) {
      restoring.current = null;
      onSetDraftId(null);
      return;
    }
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
