/**
 * useDraftReviewController — shared state machine for reviewing AI document drafts.
 *
 * Cards and the preview overlay both let the writer apply or discard a draft;
 * this controller keeps those paths on one accept/reject flow so overlap
 * confirmation and overlay cleanup cannot drift between surfaces.
 */
import { useCallback, useMemo, useState } from "react";

import { useAcceptDraft, useRejectDraft } from "@/client/query/useDraftReviewMutations";

export type DraftReviewSelection = {
  documentId: string;
  draftId: string;
};

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
  overlap: DraftReviewOverlap | null;
  isAccepting: boolean;
  isRejecting: boolean;
  isPending: boolean;
  openReview: (documentId: string, draftId: string, options?: DraftReviewOpenOptions) => void;
  closeReview: () => void;
  accept: (
    documentId: string,
    draftId: string,
    options?: { confirmedLiveRevisionToken?: number },
  ) => void;
  reject: (documentId: string, draftId: string) => void;
};

export function useDraftReviewController(threadId: string): DraftReviewController {
  const acceptMutation = useAcceptDraft();
  const rejectMutation = useRejectDraft();
  const [selectedDraft, setSelectedDraft] = useState<DraftReviewSelection | null>(null);
  const [overlap, setOverlap] = useState<DraftReviewOverlap | null>(null);

  const isAccepting = acceptMutation.isPending;
  const isRejecting = rejectMutation.isPending;
  const isPending = isAccepting || isRejecting;

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

  const accept = useCallback(
    (documentId: string, draftId: string, options?: { confirmedLiveRevisionToken?: number }) => {
      if (isPending) return;
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
            if (response.status === "overlap") {
              setOverlap({
                draftId: response.draftId,
                liveRevisionToken: response.liveRevisionToken,
                live: response.live,
                preview: response.preview,
              });
              setSelectedDraft({ documentId, draftId: response.draftId });
              return;
            }
            setOverlap((current) => (current?.draftId === draftId ? null : current));
            setSelectedDraft((current) => (current?.draftId === draftId ? null : current));
          },
        },
      );
    },
    [acceptMutation, isPending, overlap, threadId],
  );

  const reject = useCallback(
    (documentId: string, draftId: string) => {
      if (isPending) return;
      rejectMutation.mutate(
        { threadId, documentId, draftId },
        {
          onSuccess() {
            setOverlap((current) => (current?.draftId === draftId ? null : current));
            setSelectedDraft((current) => (current?.draftId === draftId ? null : current));
          },
        },
      );
    },
    [isPending, rejectMutation, threadId],
  );

  return useMemo(
    () => ({
      threadId,
      selectedDraft,
      overlap,
      isAccepting,
      isRejecting,
      isPending,
      openReview,
      closeReview,
      accept,
      reject,
    }),
    [
      threadId,
      selectedDraft,
      overlap,
      isAccepting,
      isRejecting,
      isPending,
      openReview,
      closeReview,
      accept,
      reject,
    ],
  );
}
