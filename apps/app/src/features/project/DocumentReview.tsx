import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useWorks } from "@/client/query/useWorks";
import type { OpenDocument } from "@/client/stores";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import {
  type DraftPage,
  DraftPageProvider,
  type ReviewMode,
  ReviewModeProvider,
  ReviewSurface,
  ReviewSurfaceProvider,
} from "@/features/draft-review/review-mode";
import { useDraftCommandOwner } from "./context/account-feature-context";
import { useHostReviewMode } from "./use-review-mode";
import { useWorkScopeState } from "./use-work-scope";
import { type DocumentPaint, useDocumentPaint } from "./views";

export type DocumentReview = {
  value: DraftReviewContextValue;
  paint: DocumentPaint;
  mode: ReviewMode | null;
  page: DraftPage | null;
  surface: ReviewSurface;
};

const DocumentPaintContext = createContext<DocumentPaint | null>(null);

export function useHostDocumentPaint(): DocumentPaint | null {
  return useContext(DocumentPaintContext);
}

export function useDocumentReview(
  projectId: string,
  hostTab: OpenDocument | null,
  showing: boolean,
): DocumentReview {
  const tab = showing ? hostTab : null;
  const paint = useDocumentPaint(projectId, tab);
  const documentId = tab?.documentId ?? null;
  const { workId: activeWorkId } = useWorkScopeState(projectId);
  const { works, noWork } = useWorks(projectId);
  const draftId = paint.draft?.draftId ?? paint.view.pin?.draftId ?? paint.scopeDraftId ?? "";
  const reviewWork =
    (draftId ? works?.find((work) => work.draftId === draftId) : undefined) ??
    (activeWorkId === noWork?.id
      ? noWork
      : (works?.find((work) => work.id === activeWorkId) ?? null));
  const value = useDraftReviewScopeValue({ projectId, work: reviewWork, draftId });

  const mode = useHostReviewMode(projectId, documentId, paint);
  const pin = paint.draft;
  const page = useMemo(
    () =>
      documentId && pin
        ? { projectId, documentId, draftId: pin.draftId, itemKey: pin.itemKey }
        : null,
    [projectId, documentId, pin],
  );
  const { notices } = useDraftCommandOwner();
  const pageDraftId = page?.draftId;
  useEffect(
    () => (documentId && pageDraftId ? notices.showPage(documentId, pageDraftId) : undefined),
    [notices, documentId, pageDraftId],
  );
  const [surface] = useState(() => new ReviewSurface());
  return { value, paint, mode, page, surface };
}

export function DocumentReviewProvider({
  projectId,
  document,
  showing,
  children,
}: {
  projectId: string;
  document: OpenDocument | null;
  showing: boolean;
  children: ReactNode;
}) {
  const review = useDocumentReview(projectId, document, showing);
  return (
    <DraftReviewBoundary value={review.value}>
      <DocumentPaintContext.Provider value={review.paint}>
        <DraftPageProvider value={review.page}>
          <ReviewModeProvider value={review.mode}>
            <ReviewSurfaceProvider value={review.surface}>{children}</ReviewSurfaceProvider>
          </ReviewModeProvider>
        </DraftPageProvider>
      </DocumentPaintContext.Provider>
    </DraftReviewBoundary>
  );
}
