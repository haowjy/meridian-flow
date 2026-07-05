/**
 * useDraftReviewController — shared state machine for reviewing AI document drafts.
 *
 * The dock and editor header both address the same inline review session;
 * this controller keeps whole-draft apply/discard, overlap confirmation, and
 * editor focus state on one path so review surfaces cannot drift.
 */

import { draftRoomName } from "@meridian/contracts/protocol";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { useCallback, useMemo, useReducer, useRef } from "react";
import { getDraftPreview } from "@/client/api/drafts-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useAcceptDraft, useRejectDraft } from "@/client/query/useDraftReviewMutations";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import {
  acceptIsBlocked,
  type DraftReviewOverlap,
  type DraftReviewSelection,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  inlineReviewFromState,
} from "./draft-review-controller-transitions";

export type { DraftReviewOverlap, DraftReviewSelection, InlineDraftReview };

type InlineReviewRuntime = { editor: Editor | null };

export type DraftReviewController = {
  projectId: string;
  workId: string;
  /** Focused thread owning this review surface; threads accept/reject/undo cache invalidation. */
  threadId: string | null;
  inlineReview: InlineDraftReview | null;
  overlap: DraftReviewOverlap | null;
  staleDraft: DraftReviewSelection | null;
  staleDraftMessage: string | null;
  /** Terminal placement failure for a whole draft in inline review. */
  cannotPlaceDraft: DraftReviewSelection | null;
  isAccepting: boolean;
  isRejecting: boolean;
  isPending: boolean;
  enterInlineReview: (documentId: string, draftId: string) => void;
  exitInlineReview: () => void;
  exitReview: () => void;
  inlineReviewModelAvailable: (
    identity: string,
    documentId: string,
    draftId: string,
    operationIds: readonly string[],
  ) => void;
  /**
   * Claim/release the single review-runtime slot. Registration is claim-based:
   * only the editor that holds the claim can release it. This matters because
   * the context host keeps warm HIDDEN editors mounted — an unconditional
   * "clear on not-in-review" from any of them would stomp the active review
   * editor's registration (found live: card clicks silently no-oped after
   * switching review documents).
   */
  registerInlineReviewRuntime: (runtime: InlineReviewRuntime) => void;
  releaseInlineReviewRuntime: (editor: Editor) => void;
  /**
   * Highlight and scroll the reviewed document to an operation's span. Reads
   * the review editor off the runtime so any surface (the dock Changes rows)
   * can drive the manuscript without holding the editor handle itself.
   */
  focusReviewOperation: (operationId: string) => void;
  accept: (
    documentId: string,
    draftId: string,
    options?: {
      confirmedLiveRevisionToken?: number;
    },
  ) => Promise<void>;
  reject: (documentId: string, draftId: string) => void;
};

export function useDraftReviewController(
  projectId: string,
  workId: string,
  threadId: string | null = null,
): DraftReviewController {
  const queryClient = useQueryClient();
  const acceptMutation = useAcceptDraft();
  const rejectMutation = useRejectDraft();
  const [state, dispatch] = useReducer(draftReviewReducer, EMPTY_DRAFT_REVIEW_STATE);
  const stateRef = useRef(state);
  const inlineRuntimeRef = useRef<InlineReviewRuntime | null>(null);
  stateRef.current = state;

  const inlineReview = inlineReviewFromState(state);
  const overlap = state.overlap;
  const staleDraft = state.staleDraft;
  const cannotPlaceDraft = state.cannotPlaceDraft;

  const staleDraftMessage = staleDraft
    ? "The draft changed — review the latest changes before applying."
    : null;
  const isAccepting = acceptMutation.isPending;
  const isRejecting = rejectMutation.isPending;
  const isPending = isAccepting || isRejecting;

  const enterInlineReview = useCallback((documentId: string, draftId: string) => {
    dispatch({ type: "enterInline", documentId, draftId });
  }, []);

  const exitInlineReview = useCallback(() => {
    dispatch({ type: "exitInline" });
  }, []);

  const exitReview = useCallback(() => {
    dispatch({ type: "exitReview" });
  }, []);

  const inlineReviewModelAvailable = useCallback(
    (identity: string, documentId: string, draftId: string, _operationIds: readonly string[]) => {
      dispatch({ type: "inlineModelAvailable", identity, documentId, draftId });
    },
    [],
  );

  const registerInlineReviewRuntime = useCallback((runtime: InlineReviewRuntime) => {
    inlineRuntimeRef.current = runtime;
  }, []);

  // Release is a no-op unless the caller still holds the claim: on a review
  // document switch the new editor may register before the old one's effect
  // cleanup runs, and that stale cleanup must not clear the fresh claim.
  const releaseInlineReviewRuntime = useCallback((editor: Editor) => {
    if (inlineRuntimeRef.current?.editor === editor) {
      inlineRuntimeRef.current = null;
    }
  }, []);

  const focusReviewOperation = useCallback((operationId: string) => {
    const editor = inlineRuntimeRef.current?.editor;
    if (!editor || editor.isDestroyed) return;
    editor.commands.setInlineReviewActiveOperation(operationId);
    editor.commands.scrollInlineReviewOperationIntoView(operationId);
  }, []);

  const accept = useCallback(
    async (
      documentId: string,
      draftId: string,
      options?: { confirmedLiveRevisionToken?: number },
    ) => {
      if (
        acceptIsBlocked({
          isPending,
          isCannotPlaceTerminal:
            stateRef.current.cannotPlaceDraft?.documentId === documentId &&
            stateRef.current.cannotPlaceDraft.draftId === draftId,
        })
      ) {
        return;
      }
      const needsOverlapConfirm = overlap?.draftId === draftId;
      await waitForDraftDocumentSync(draftId);
      const { draftRevisionToken } = await latestPreviewRevisionTokens(
        queryClient,
        projectId,
        workId,
        documentId,
        draftId,
      );
      acceptMutation.mutate(
        {
          projectId,
          workId,
          threadId,
          documentId,
          draftId,
          draftRevisionToken,
          confirmOverlap: needsOverlapConfirm,
          confirmedLiveRevisionToken: needsOverlapConfirm
            ? (options?.confirmedLiveRevisionToken ?? overlap.liveRevisionToken)
            : undefined,
        },
        {
          onSuccess(response) {
            if (response.status === "stale_draft" || response.status === "causal_dependency") {
              void queryClient.invalidateQueries({
                queryKey: projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
              });
            }
            dispatch({ type: "applySucceeded", documentId, draftId, response });
          },
        },
      );
    },
    [acceptMutation, isPending, overlap, queryClient, projectId, workId, threadId],
  );

  const reject = useCallback(
    (documentId: string, draftId: string) => {
      if (isPending) return;
      rejectMutation.mutate(
        { projectId, workId, threadId, documentId, draftId },
        {
          onSuccess() {
            dispatch({ type: "rejectSucceeded", draftId });
          },
        },
      );
    },
    [isPending, rejectMutation, projectId, workId, threadId],
  );

  return useMemo(
    () => ({
      projectId,
      workId,
      threadId,
      inlineReview,
      overlap,
      staleDraft,
      staleDraftMessage,
      cannotPlaceDraft,
      isAccepting,
      isRejecting,
      isPending,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      focusReviewOperation,
      accept,
      reject,
    }),
    [
      projectId,
      workId,
      threadId,
      inlineReview,
      overlap,
      staleDraft,
      staleDraftMessage,
      cannotPlaceDraft,
      isAccepting,
      isRejecting,
      isPending,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      focusReviewOperation,
      accept,
      reject,
    ],
  );
}

const ACCEPT_SYNC_WAIT_MS = 1500;

type DraftPreviewRevisionTokens = { draftRevisionToken: number; liveRevisionToken: number | null };

async function latestPreviewRevisionTokens(
  queryClient: QueryClient,
  projectId: string,
  workId: string,
  documentId: string,
  draftId: string,
): Promise<DraftPreviewRevisionTokens> {
  const queryKey = projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId);
  const preview = await getDraftPreview(projectId, workId, documentId, draftId);
  queryClient.setQueryData(queryKey, preview);
  return preview.status === "active"
    ? {
        draftRevisionToken: preview.draftRevisionToken,
        liveRevisionToken: preview.liveRevisionToken,
      }
    : { draftRevisionToken: -1, liveRevisionToken: null };
}

async function waitForDraftDocumentSync(draftId: string): Promise<void> {
  const registry = getDocumentSessionRegistry();
  const roomKey = draftRoomName(draftId);
  if (!registry.has(roomKey)) return;
  const session = registry.getRoom(roomKey);
  if (session.getSnapshot().status === "synced") return;
  await session.waitForCurrentSync(ACCEPT_SYNC_WAIT_MS);
}
