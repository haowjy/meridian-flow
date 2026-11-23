/** A document host's draft scope: the draft's list and its Apply and Discard, for every surface the host renders. */

import type { Work } from "@meridian/contracts/works";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { type DraftReviewController, useDraftReviewController } from "./useDraftReviewController";

export type DraftReviewContextValue = {
  controller: DraftReviewController;
  files: ReviewFileTarget[];
  fileForDocument: (documentId: string | null | undefined) => ReviewFileTarget | null;
  /** Returns the host's document to Live. */
  showLive: () => void;
};

const NO_FILES: ReviewFileTarget[] = [];

const DraftReviewContext = createContext<DraftReviewContextValue | null>(null);

export function DraftReviewBoundary({
  value,
  children,
}: {
  value: DraftReviewContextValue;
  children: ReactNode;
}) {
  return <DraftReviewContext.Provider value={value}>{children}</DraftReviewContext.Provider>;
}

export function useDraftReviewScopeValue({
  projectId,
  work,
  draftId,
  threadId = null,
  showLive,
}: {
  projectId: string | null;
  /** The Work the draft belongs to, if any. */
  work: Work | null;
  /** The draft this scope reviews; "" scopes nothing. */
  draftId: string;
  /** Focused thread, when this review surface is thread-owned; threads cache invalidation. */
  threadId?: string | null;
  showLive: () => void;
}): DraftReviewContextValue {
  const drafts = useOwnerDrafts(projectId, draftId || null);
  const files = drafts.files ?? NO_FILES;
  const controller = useDraftReviewController({
    projectId: projectId ?? "",
    work,
    draftId,
    threadId,
  });
  const fileForDocument = drafts.fileForDocument;
  return useMemo<DraftReviewContextValue>(
    () => ({ controller, files, fileForDocument, showLive }),
    [showLive, controller, files, fileForDocument],
  );
}

export function useDraftReview(): DraftReviewContextValue {
  const value = useContext(DraftReviewContext);
  if (!value) {
    throw new Error("useDraftReview must be used within DraftReviewBoundary");
  }
  return value;
}

/** The host's review, or null outside a document host (an editor that is not a page). */
export function useOptionalDraftReview(): DraftReviewContextValue | null {
  return useContext(DraftReviewContext);
}
