/**
 * One document host's review scope and paint: what the document shows (Live or a draft) and the
 * draft's list. Every host that holds a document (main, the side, the phone) gets one, so two
 * documents on screen show two drafts without sharing state. Commands stay account-wide and
 * queued per item (`DraftCommandOwner`). Painting a draft opens the plain draft; Review changes is
 * on only where the host's address (main) or stored slot (the side) says (`useHostReviewMode`).
 *
 * Only a host on screen paints a draft. The kept document's host and a closed side's host stay
 * mounted hidden and paint Live.
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { setDocumentView } from "@/client/project-shell/document-views";
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
import { useAccountId } from "./context/account-feature-context";
import { useShellTreeVersion } from "./tree-version";
import { useHostReviewMode } from "./use-review-mode";
import { useWorkScopeState } from "./use-work-scope";
import { type DocumentPaint, useDocumentPaint } from "./views";

export type DocumentReview = {
  value: DraftReviewContextValue;
  paint: DocumentPaint;
  /** Review changes on this host; null on Live and on a plain draft. */
  mode: ReviewMode | null;
  page: DraftPage | null;
  surface: ReviewSurface;
};

const DocumentPaintContext = createContext<DocumentPaint | null>(null);

/** The paint of the document whose host this is; null outside a document host. */
export function useHostDocumentPaint(): DocumentPaint | null {
  return useContext(DocumentPaintContext);
}

export function useDocumentReview(
  projectId: string,
  hostTab: OpenDocument | null,
  showing: boolean,
): DocumentReview {
  const tab = showing ? hostTab : null;
  const accountId = useAccountId();
  const paint = useDocumentPaint(projectId, tab);
  const documentId = tab?.documentId ?? null;
  const { workId: activeWorkId } = useWorkScopeState(projectId);
  const { works, noWork } = useWorks(projectId);
  const draftId = paint.draft?.draftId ?? paint.view.pin?.draftId ?? paint.scopeDraftId ?? "";
  // A lineage's drafts carry no Work: its review reads the scope's Work for archive state.
  const reviewWork =
    (draftId ? works?.find((work) => work.draftId === draftId) : undefined) ??
    (activeWorkId === noWork?.id
      ? noWork
      : (works?.find((work) => work.id === activeWorkId) ?? null));
  // Live for the scope's draft is the toggle's Live (`shownDraft`); another owner's pin just goes.
  const shell = useShellTreeVersion();
  const scopeShown = paint.draft !== null && !paint.outOfScope;
  const showLive = useCallback(() => {
    if (documentId) setDocumentView(accountId, projectId, documentId, { version: "live" });
    if (scopeShown) shell?.show("live");
  }, [accountId, projectId, documentId, scopeShown, shell]);
  const value = useDraftReviewScopeValue({
    projectId,
    work: reviewWork,
    draftId,
    threadId: null,
    showLive,
  });

  const mode = useHostReviewMode(projectId, documentId, paint);
  const pin = paint.draft;
  const page = useMemo(
    () =>
      documentId && pin
        ? { projectId, documentId, draftId: pin.draftId, itemKey: pin.itemKey }
        : null,
    [projectId, documentId, pin],
  );
  const [surface] = useState(() => new ReviewSurface());
  return { value, paint, mode, page, surface };
}

/** Exposes one host's review to everything that host renders, in one or several subtrees. */
export function DocumentReviewBoundary({
  review,
  children,
}: {
  review: DocumentReview;
  children: ReactNode;
}) {
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

/** A document host's own review, for a host whose chrome and body share one subtree. */
export function DocumentReviewProvider({
  projectId,
  document,
  showing,
  children,
}: {
  projectId: string;
  document: OpenDocument | null;
  /** Whether the host is on screen; one that is not reviews nothing. */
  showing: boolean;
  children: ReactNode;
}) {
  const review = useDocumentReview(projectId, document, showing);
  return <DocumentReviewBoundary review={review}>{children}</DocumentReviewBoundary>;
}
