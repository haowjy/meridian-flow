/** Active editor projection and the live presence lease shared by desktop and phone hosts. */
import { useEffect, useRef } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import { useDraftReview } from "./DraftReviewProvider";

export function useActiveReviewBinding({
  documentId,
  liveSession,
  active,
  inReview,
}: {
  documentId: string | null;
  liveSession: DocumentSession | null;
  active: boolean;
  /** Host policy: requested review on phone, the painted draft on desktop. */
  inReview: boolean;
}) {
  const { setActiveEditorDocumentId } = useDraftReview();
  const owner = useRef({});
  useEffect(() => {
    if (!active || !documentId) return;
    setActiveEditorDocumentId(documentId, owner.current);
    return () => setActiveEditorDocumentId(null, owner.current);
  }, [active, documentId, setActiveEditorDocumentId]);

  useEffect(() => {
    if (!active || !inReview || !liveSession) return;
    liveSession.suspendPresence();
    return () => liveSession.resumePresence();
  }, [active, inReview, liveSession]);
}
