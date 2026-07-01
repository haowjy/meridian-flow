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
  acceptAll: (documentId: string, draftIds: readonly string[]) => void;
  rejectAll: (documentId: string, draftIds: readonly string[]) => void;
};

export function useDraftReviewController(threadId: string): DraftReviewController {
  const acceptMutation = useAcceptDraft();
  const rejectMutation = useRejectDraft();
  const [selectedDraft, setSelectedDraft] = useState<DraftReviewSelection | null>(null);
  const [overlap, setOverlap] = useState<DraftReviewOverlap | null>(null);
  const [isBatchPending, setIsBatchPending] = useState(false);

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

  const acceptAll = useCallback(
    async (documentId: string, draftIds: readonly string[]) => {
      if (isPending || draftIds.length === 0) return;
      setIsBatchPending(true);
      try {
        for (const draftId of draftIds) {
          const response = await acceptMutation.mutateAsync({ threadId, documentId, draftId });
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
        }
      } catch {
        // Mutation state carries the failure; the batch simply stops at the first error.
      } finally {
        setIsBatchPending(false);
      }
    },
    [acceptMutation, isPending, threadId],
  );

  const rejectAll = useCallback(
    async (documentId: string, draftIds: readonly string[]) => {
      if (isPending || draftIds.length === 0) return;
      setIsBatchPending(true);
      try {
        for (const draftId of draftIds) {
          await rejectMutation.mutateAsync({ threadId, documentId, draftId });
          setOverlap((current) => (current?.draftId === draftId ? null : current));
          setSelectedDraft((current) => (current?.draftId === draftId ? null : current));
        }
      } catch {
        // Mutation state carries the failure; the batch simply stops at the first error.
      } finally {
        setIsBatchPending(false);
      }
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
      acceptAll,
      rejectAll,
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
      acceptAll,
      rejectAll,
    ],
  );
}
