/**
 * useReviewGeneration — the open review follows its draft's generation.
 *
 * The server closes a draft by resetting its branch one generation up, and the
 * same draft id carries the next proposal (`ThreadDraftListItem.draftGeneration`).
 * This watches what the caches say of the open draft, its list row and its
 * preview, and reports each as an observation addressed to that draft. It
 * decides nothing: the reducer compares the observed generation with the one
 * the review shows and either ignores it, refreshes, or re-enters the new
 * proposal in place (rows O1-O4 of `draft-review-session`).
 *
 * Observation only: the hook never reads the network. The room read, the
 * refresh owner and the surfaces' own readers fetch, and this sees what lands.
 * It reports before paint so a surface never draws a review beside a preview
 * of another generation.
 */

import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useLayoutEffect } from "react";
import { draftPreviewQueryOptions } from "@/client/query/useDraftPreview";
import { workDraftsQueryOptions } from "@/client/query/useWorkDrafts";
import type {
  DraftReviewAction,
  InlineDraftReview,
  ProposalEvidence,
} from "./draft-review-session";
import { reviewChangesOfPreview } from "./review-changes";
import { draftClaim } from "./useReviewCommandCompletion";

export function useReviewGeneration({
  projectId,
  workId,
  inlineReview,
  activeRef,
  dispatch,
}: {
  projectId: string;
  workId: string;
  inlineReview: InlineDraftReview | null;
  activeRef: { readonly current: boolean };
  dispatch: Dispatch<DraftReviewAction>;
}): void {
  const queryClient = useQueryClient();
  const documentId = inlineReview?.documentId ?? "";
  const draftId = inlineReview?.draftId ?? "";
  const observing = Boolean(projectId && workId && documentId && draftId);

  const { data: listed } = useQuery({
    ...workDraftsQueryOptions(projectId, workId),
    enabled: false,
    select: (rows) => rows.find((row) => row.draftId === draftId)?.draftGeneration ?? null,
  });
  const previewed = useCachedProposal({ projectId, workId, documentId, draftId });

  const listedGeneration = observing ? (listed ?? null) : null;
  useLayoutEffect(() => {
    if (!activeRef.current || listedGeneration === null) return;
    // A list row is always a proposal.
    dispatch({
      type: "generationObserved",
      documentId,
      draftId,
      draftGeneration: listedGeneration,
      proposal: true,
      claim: claimOf(queryClient, projectId, workId, documentId, draftId),
    });
  }, [listedGeneration, documentId, draftId, projectId, workId, queryClient, activeRef, dispatch]);

  const previewedGeneration = observing ? (previewed?.draftGeneration ?? null) : null;
  const previewedProposal = observing ? (previewed?.proposal ?? false) : false;
  useLayoutEffect(() => {
    if (!activeRef.current || previewedGeneration === null) return;
    dispatch({
      type: "generationObserved",
      documentId,
      draftId,
      draftGeneration: previewedGeneration,
      proposal: previewedProposal,
      claim: claimOf(queryClient, projectId, workId, documentId, draftId),
    });
  }, [
    previewedGeneration,
    previewedProposal,
    documentId,
    draftId,
    projectId,
    workId,
    queryClient,
    activeRef,
    dispatch,
  ]);
}

/**
 * What the draft's cached preview says of its proposal: the generation it
 * describes and whether it lists changes. Null while no active preview is
 * cached. Reads the cache only.
 */
export function useCachedProposal(draft: {
  projectId: string;
  workId: string;
  documentId: string;
  draftId: string;
}): ProposalEvidence | null {
  const { data } = useQuery({
    ...draftPreviewQueryOptions(draft),
    enabled: false,
    select: (preview) =>
      preview.status === "active"
        ? {
            draftGeneration: preview.draftGeneration,
            proposal: preview.inlineModelPresent && reviewChangesOfPreview(preview).length > 0,
          }
        : null,
  });
  return data ?? null;
}

function claimOf(
  queryClient: QueryClient,
  projectId: string,
  workId: string,
  documentId: string,
  draftId: string,
) {
  return draftClaim(queryClient, { projectId, workId, documentId, draftId });
}
