/**
 * useDraftReviewController — shared state machine for reviewing AI document drafts.
 *
 * Cards and the preview overlay both let the writer apply or discard a draft;
 * this controller keeps those paths on one accept/reject flow so overlap
 * confirmation and overlay cleanup cannot drift between surfaces.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAcceptDraft, useRejectDraft } from "@/client/query/useDraftReviewMutations";

import {
  acceptIsBlocked,
  type DraftReviewSurfaceState,
  stateAfterAcceptResult,
  stateAfterRejectSuccess,
} from "./draft-review-controller-transitions";
import {
  inlineReviewDiscardIsPending,
  useInlineReviewDiscardPending,
} from "./inline-review-discard-state";

export type DraftReviewSelection = {
  documentId: string;
  draftId: string;
};

export type InlineDraftReview = DraftReviewSelection;

export type DraftReviewOpenOptions = {
  requireOverlapConfirm?: boolean;
  liveRevisionToken?: number;
};

export type DraftReviewOverlap = {
  draftId: string;
  liveRevisionToken?: number;
  live?: string;
  preview?: string;
};

export type DraftReviewController = {
  threadId: string;
  selectedDraft: DraftReviewSelection | null;
  inlineReview: InlineDraftReview | null;
  overlap: DraftReviewOverlap | null;
  isAccepting: boolean;
  isRejecting: boolean;
  isPending: boolean;
  isInlineDiscardPending: boolean;
  openReview: (documentId: string, draftId: string, options?: DraftReviewOpenOptions) => void;
  closeReview: () => void;
  enterInlineReview: (documentId: string, draftId: string) => void;
  exitInlineReview: () => void;
  fallbackInlineReviewToPanel: (documentId: string, draftId: string) => void;
  accept: (
    documentId: string,
    draftId: string,
    options?: { confirmedLiveRevisionToken?: number },
  ) => void;
  reject: (documentId: string, draftId: string) => void;
  acceptAll: (documentId: string, draftIds: readonly string[]) => void;
  rejectAll: (documentId: string, draftIds: readonly string[]) => void;
};

export function useDraftReviewController(threadId: string): DraftReviewController {
  const acceptMutation = useAcceptDraft();
  const rejectMutation = useRejectDraft();
  const [selectedDraft, setSelectedDraft] = useState<DraftReviewSelection | null>(null);
  const [inlineReview, setInlineReview] = useState<InlineDraftReview | null>(null);
  const [overlap, setOverlap] = useState<DraftReviewOverlap | null>(null);
  const [isBatchPending, setIsBatchPending] = useState(false);
  const surfaceStateRef = useRef<DraftReviewSurfaceState>({
    selectedDraft: null,
    inlineReview: null,
    overlap: null,
  });
  const isInlineDiscardPending = useInlineReviewDiscardPending();

  useEffect(() => {
    surfaceStateRef.current = { selectedDraft, inlineReview, overlap };
  }, [selectedDraft, inlineReview, overlap]);

  const isAccepting = acceptMutation.isPending;
  const isRejecting = rejectMutation.isPending;
  const isPending = isAccepting || isRejecting || isBatchPending;

  const openReview = useCallback(
    (documentId: string, draftId: string, options?: DraftReviewOpenOptions) => {
      setOverlap(
        options?.requireOverlapConfirm
          ? { draftId, liveRevisionToken: options.liveRevisionToken }
          : null,
      );
      setSelectedDraft({ documentId, draftId });
    },
    [],
  );

  const closeReview = useCallback(() => {
    setSelectedDraft(null);
    setOverlap(null);
  }, []);

  const enterInlineReview = useCallback((documentId: string, draftId: string) => {
    setInlineReview({ documentId, draftId });
    setSelectedDraft(null);
    setOverlap(null);
  }, []);

  const exitInlineReview = useCallback(() => {
    setInlineReview(null);
  }, []);

  const fallbackInlineReviewToPanel = useCallback((documentId: string, draftId: string) => {
    setInlineReview((current) => (current?.draftId === draftId ? null : current));
    setOverlap(null);
    setSelectedDraft({ documentId, draftId });
  }, []);

  const commitSurfaceState = useCallback(
    (nextState: (state: DraftReviewSurfaceState) => DraftReviewSurfaceState) => {
      const next = nextState(surfaceStateRef.current);
      surfaceStateRef.current = next;
      setSelectedDraft(next.selectedDraft);
      setInlineReview(next.inlineReview);
      setOverlap(next.overlap);
    },
    [],
  );

  const accept = useCallback(
    (documentId: string, draftId: string, options?: { confirmedLiveRevisionToken?: number }) => {
      if (acceptIsBlocked({ isPending, isInlineDiscardPending: inlineReviewDiscardIsPending() })) {
        return;
      }
      const needsOverlapConfirm = overlap?.draftId === draftId;
      acceptMutation.mutate(
        {
          threadId,
          documentId,
          draftId,
          confirmOverlap: needsOverlapConfirm,
          confirmedLiveRevisionToken: needsOverlapConfirm
            ? (options?.confirmedLiveRevisionToken ?? overlap.liveRevisionToken)
            : undefined,
        },
        {
          onSuccess(response) {
            commitSurfaceState((state) =>
              stateAfterAcceptResult(state, { documentId, draftId, response }),
            );
          },
        },
      );
    },
    [acceptMutation, commitSurfaceState, isPending, overlap, threadId],
  );

  const reject = useCallback(
    (documentId: string, draftId: string) => {
      if (isPending) return;
      rejectMutation.mutate(
        { threadId, documentId, draftId },
        {
          onSuccess() {
            commitSurfaceState((state) => stateAfterRejectSuccess(state, draftId));
          },
        },
      );
    },
    [commitSurfaceState, isPending, rejectMutation, threadId],
  );

  const acceptAll = useCallback(
    async (documentId: string, draftIds: readonly string[]) => {
      if (
        draftIds.length === 0 ||
        acceptIsBlocked({ isPending, isInlineDiscardPending: inlineReviewDiscardIsPending() })
      ) {
        return;
      }
      setIsBatchPending(true);
      try {
        for (const draftId of draftIds) {
          const response = await acceptMutation.mutateAsync({ threadId, documentId, draftId });
          commitSurfaceState((state) =>
            stateAfterAcceptResult(state, { documentId, draftId, response }),
          );
          if (response.status === "overlap") return;
        }
      } catch {
        // Mutation state carries the failure; the batch simply stops at the first error.
      } finally {
        setIsBatchPending(false);
      }
    },
    [acceptMutation, commitSurfaceState, isPending, threadId],
  );

  const rejectAll = useCallback(
    async (documentId: string, draftIds: readonly string[]) => {
      if (isPending || draftIds.length === 0) return;
      setIsBatchPending(true);
      try {
        for (const draftId of draftIds) {
          await rejectMutation.mutateAsync({ threadId, documentId, draftId });
          commitSurfaceState((state) => stateAfterRejectSuccess(state, draftId));
        }
      } catch {
        // Mutation state carries the failure; the batch simply stops at the first error.
      } finally {
        setIsBatchPending(false);
      }
    },
    [commitSurfaceState, isPending, rejectMutation, threadId],
  );

  return useMemo(
    () => ({
      threadId,
      selectedDraft,
      inlineReview,
      overlap,
      isAccepting,
      isRejecting,
      isPending,
      isInlineDiscardPending,
      openReview,
      closeReview,
      enterInlineReview,
      exitInlineReview,
      fallbackInlineReviewToPanel,
      accept,
      reject,
      acceptAll,
      rejectAll,
    }),
    [
      threadId,
      selectedDraft,
      inlineReview,
      overlap,
      isAccepting,
      isRejecting,
      isPending,
      isInlineDiscardPending,
      openReview,
      closeReview,
      enterInlineReview,
      exitInlineReview,
      fallbackInlineReviewToPanel,
      accept,
      reject,
      acceptAll,
      rejectAll,
    ],
  );
}
