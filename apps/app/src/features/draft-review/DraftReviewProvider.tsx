/** A document host's draft scope: the draft's list and its Apply and Discard, for every surface the host renders. */

import type { Work } from "@meridian/contracts/works";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { usePressCommands, type WorkDraftCommands } from "./usePressCommands";

export type DraftReviewContextValue = {
  controller: WorkDraftCommands;
  fileForDocument: (documentId: string | null | undefined) => ReviewFileTarget | null;
};

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
}: {
  projectId: string | null;
  /** The Work the draft belongs to, if any. */
  work: Work | null;
  /** The draft this scope reviews; "" scopes nothing. */
  draftId: string;
  /** Focused thread, when this review surface is thread-owned; threads cache invalidation. */
  threadId?: string | null;
}): DraftReviewContextValue {
  const { fileForDocument } = useOwnerDrafts(projectId, draftId || null);
  const drafts = useMemo(() => (draftId ? [draftId] : []), [draftId]);
  const controller = usePressCommands({
    projectId: projectId ?? "",
    work,
    drafts,
    threadId,
    surface: "page",
  });
  return useMemo(() => ({ controller, fileForDocument }), [controller, fileForDocument]);
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
