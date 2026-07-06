/**
 * useDraftReviewController — shared state machine for reviewing AI document drafts.
 *
 * The dock Changes cards and editor header both address the same inline review
 * session; this controller keeps whole-draft apply/discard, per-card
 * Apply/Discard, overlap/closure confirmation, and editor focus state on one
 * path so review surfaces cannot drift. Per-card Apply routes the closure-aware
 * `acceptDraft` mutation with `operationIds`; per-card Discard applies a
 * journal-inverse Yjs update locally (see `inline-review-discard-operation.ts`)
 * so a single change reverses without re-running the whole draft.
 */

import { draftRoomName } from "@meridian/contracts/protocol";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { getDraftPreview } from "@/client/api/drafts-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  useAcceptDraft,
  useRejectDraft,
  useUndoDraftAccept,
} from "@/client/query/useDraftReviewMutations";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { InlineReviewModel } from "@/core/editor/extensions/inline-review";
import {
  acceptIsBlocked,
  cannotPlaceOperationIdsForDraft,
  type DraftReviewOverlap,
  type DraftReviewSelection,
  discardCanStart,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  type InlineReviewMessage,
  type InlineReviewMessageCode,
  inlineDiscardIsPending,
  inlineReviewFromState,
  pendingDiscardIdsForDraft,
  pendingDiscardIdsSettledByPreview,
} from "./draft-review-controller-transitions";
import {
  type InlineReviewJournalCache,
  type InlineReviewRejectContext,
  type InlineReviewRejectOutcome,
  rejectInlineReviewOperation,
} from "./inline-review-discard-operation";

export type {
  DraftReviewOverlap,
  DraftReviewSelection,
  InlineDraftReview,
  InlineReviewMessageCode,
};

/**
 * The single review-runtime claim. It carries the full reject context (draft
 * Y.Doc + identifiers) because per-card Discard reconstructs the inverse update
 * against the live draft doc, not just the editor. Registration is claim-based
 * on the editor identity (see register/release below).
 */
export type InlineReviewRuntime = InlineReviewRejectContext & { editor: Editor };

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
  isInlineDiscardPending: boolean;
  /** True while a per-card Apply is in flight (its own mutation, not Apply all). */
  isOperationAccepting: boolean;
  /** True while a per-card Apply's Undo is in flight. */
  isOperationUndoing: boolean;
  /**
   * The global disposition lock: any accept/discard in flight in the session.
   * Every mutating control disables on it so dispositions can't overlap.
   */
  isDisposing: boolean;
  pendingInlineDiscardIds: (draftId: string | null | undefined) => ReadonlySet<string>;
  cannotPlaceInlineOperationIds: (draftId: string | null | undefined) => ReadonlySet<string>;
  /** The operation whose per-card Apply is in flight, or null. */
  acceptingOperationId: string | null;
  confirmingAcceptOperationId: string | null;
  confirmingDiscardOperationId: string | null;
  inlineReviewMessage: InlineReviewMessage | null;
  inlineDiscardError: InlineReviewMessageCode | null;
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
   * the review editor off the runtime so any surface (the dock Changes cards)
   * can drive the manuscript without holding the editor handle itself.
   */
  focusReviewOperation: (operationId: string) => void;
  confirmAcceptOperation: (operationId: string) => void;
  cancelAcceptOperation: () => void;
  acceptOperation: (operationId: string, model: InlineReviewModel) => void;
  undoAcceptOperation: () => void;
  confirmDiscardOperation: (operationId: string) => void;
  cancelDiscardOperation: () => void;
  discardOperation: (operationId: string) => Promise<void>;
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
  // A dedicated accept mutation for per-card Apply keeps its in-flight state
  // separate from whole-draft Apply all, so the two surfaces never disable
  // each other by sharing one `isPending`.
  const operationAcceptMutation = useAcceptDraft();
  const undoAcceptMutation = useUndoDraftAccept();
  const rejectMutation = useRejectDraft();
  const [state, dispatch] = useReducer(draftReviewReducer, EMPTY_DRAFT_REVIEW_STATE);
  const stateRef = useRef(state);
  const inlineRuntimeRef = useRef<InlineReviewRuntime | null>(null);
  const journalCacheRef = useRef<InlineReviewJournalCache>(new Map());
  const pendingDiscardTimersRef = useRef<Map<string, number>>(new Map());
  stateRef.current = state;

  const inlineReview = inlineReviewFromState(state);
  const overlap = state.overlap;
  const staleDraft = state.staleDraft;
  const cannotPlaceDraft = state.cannotPlaceDraft;
  const isInlineDiscardPending = inlineDiscardIsPending(state);
  const acceptingOperationId = state.acceptingOperationId;
  const confirmingAcceptOperationId = state.confirmingAcceptOperationId;
  const confirmingDiscardOperationId = state.confirmingDiscardOperationId;
  const inlineReviewMessage = state.inlineReviewMessage;
  const inlineDiscardError = state.inlineDiscardError;

  const staleDraftMessage = staleDraft
    ? "The draft changed — review the latest changes before applying."
    : null;
  const isAccepting = acceptMutation.isPending;
  const isRejecting = rejectMutation.isPending;
  const isOperationAccepting = operationAcceptMutation.isPending;
  const isOperationUndoing = undoAcceptMutation.isPending;
  const isPending = isAccepting || isRejecting;
  // The global disposition lock: any accept/discard/undo in flight anywhere in
  // the review session. Every mutating control (whole-draft Apply all / Discard
  // all AND every per-card verb, including Undo) disables on this, so the writer
  // can never stack two overlapping dispositions against the same draft.
  const isDisposing =
    isPending || isOperationAccepting || isInlineDiscardPending || isOperationUndoing;

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
    (identity: string, documentId: string, draftId: string, operationIds: readonly string[]) => {
      dispatch({ type: "inlineModelAvailable", identity, documentId, draftId });
      // A refreshed preview that no longer carries a pending-discard operation is
      // the settle signal: the reject synced and the change is gone. Clear its
      // stickiness timer and mark it settled.
      for (const operationId of pendingDiscardIdsSettledByPreview(stateRef.current, {
        documentId,
        draftId,
        operationIds,
      })) {
        clearPendingDiscardTimer(pendingDiscardTimersRef.current, draftId, operationId);
        dispatch({ type: "discardSettled", draftId, operationId });
      }
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

  const pendingInlineDiscardIds = useCallback(
    (draftId: string | null | undefined) => pendingDiscardIdsForDraft(stateRef.current, draftId),
    [],
  );
  const cannotPlaceInlineOperationIds = useCallback(
    (draftId: string | null | undefined) =>
      cannotPlaceOperationIdsForDraft(stateRef.current, draftId),
    [],
  );

  useEffect(() => {
    return () => {
      for (const timer of pendingDiscardTimersRef.current.values()) window.clearTimeout(timer);
      pendingDiscardTimersRef.current.clear();
    };
  }, []);

  const confirmAcceptOperation = useCallback((operationId: string) => {
    dispatch({ type: "confirmAcceptOperation", operationId });
  }, []);

  const cancelAcceptOperation = useCallback(() => {
    dispatch({ type: "cancelAcceptOperation" });
  }, []);

  const acceptOperation = useCallback(
    async (operationId: string, model: InlineReviewModel) => {
      const current = stateRef.current;
      const inline = current.surface.kind === "inline" ? current.surface : null;
      if (!inline) {
        dispatch({
          type: "operationAcceptFailed",
          message: { code: "open-review-first", tone: "error" },
        });
        return;
      }
      // A second Apply while one is already in flight is ignored — it must NOT
      // dispatch a failure, which would clear the real `acceptingOperationId`
      // and make the busy card look idle mid-mutation.
      if (operationAcceptMutation.isPending) return;
      const operation = model.operations.find((candidate) => candidate.operationId === operationId);
      if (!operation) {
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDraftPreview(
            projectId,
            workId,
            inline.documentId,
            inline.draftId,
          ),
        });
        dispatch({
          type: "operationAcceptFailed",
          message: { code: "change-moved", tone: "error" },
        });
        return;
      }
      const overlapConfirm = operationOverlapFor(current.overlap, inline.draftId, operationId);
      const confirmClosure = current.confirmingAcceptOperationId === operationId;
      dispatch({ type: "operationAcceptStarted", operationId });
      let revisionTokens: DraftPreviewRevisionTokens;
      try {
        await waitForDraftDocumentSync(inline.draftId);
        revisionTokens = await latestPreviewRevisionTokens(
          queryClient,
          projectId,
          workId,
          inline.documentId,
          inline.draftId,
        );
      } catch {
        dispatch({
          type: "operationAcceptFailed",
          message: { code: "apply-failed", tone: "error" },
        });
        return;
      }
      const request = operationAcceptRequest({
        draftId: inline.draftId,
        draftRevisionToken: revisionTokens.draftRevisionToken,
        operationId,
        acceptClosureOperationIds: operation.acceptClosureOperationIds,
        liveRevisionToken: revisionTokens.liveRevisionToken ?? model.liveRevisionToken,
        confirmClosure,
        overlap: overlapConfirm,
      });
      operationAcceptMutation.mutate(
        {
          projectId,
          workId,
          threadId,
          documentId: inline.documentId,
          ...request,
        },
        {
          onSuccess(response) {
            if (response.status === "partial_applied") {
              dispatch({
                type: "operationAcceptSucceeded",
                message: { code: "change-applied", writeId: response.writeId },
              });
            } else if (response.status === "stale_draft") {
              dispatch({
                type: "operationAcceptSucceeded",
                message: { code: "changes-moved-refreshed" },
              });
            } else if (response.status === "causal_dependency") {
              dispatch({
                type: "operationAcceptSucceeded",
                message: { code: "apply-dependencies-first" },
              });
            } else if (response.status === "cannot_place") {
              dispatch({
                type: "operationCannotPlace",
                draftId: inline.draftId,
                operationId,
                message: { code: "change-cannot-place", tone: "info" },
              });
            } else if (response.status === "closure_confirmation_required") {
              if (confirmClosure) {
                dispatch({
                  type: "operationAcceptSucceeded",
                  message: { code: "changes-moved-confirm-again" },
                });
              }
              dispatch({ type: "confirmAcceptOperation", operationId });
            } else if (response.status === "applied") {
              dispatch({
                type: "applySucceeded",
                documentId: inline.documentId,
                draftId: inline.draftId,
                response,
              });
            } else if (response.status === "overlap") {
              dispatch({
                type: "operationOverlapReturned",
                documentId: inline.documentId,
                overlap: {
                  draftId: response.draftId,
                  operationId,
                  liveRevisionToken: response.liveRevisionToken,
                  live: response.live,
                  preview: response.preview,
                },
              });
            }
          },
          onError() {
            dispatch({
              type: "operationAcceptFailed",
              message: { code: "apply-failed", tone: "error" },
            });
          },
        },
      );
    },
    [operationAcceptMutation, queryClient, projectId, workId, threadId],
  );

  // Reverse the most recent per-card Apply. The `writeId` rides on the
  // "Change applied" message; undo is only offered while that message stands.
  const undoAcceptOperation = useCallback(() => {
    const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
    const writeId = stateRef.current.inlineReviewMessage?.writeId;
    if (!inline || !writeId || undoAcceptMutation.isPending) return;
    undoAcceptMutation.mutate(
      {
        projectId,
        workId,
        threadId,
        documentId: inline.documentId,
        draftId: inline.draftId,
        writeId,
      },
      {
        onSuccess() {
          dispatch({
            type: "operationUndoAcceptSucceeded",
            message: { code: "change-restored" },
          });
        },
        onError() {
          dispatch({
            type: "operationUndoAcceptFailed",
            message: { code: "undo-failed", tone: "error" },
          });
        },
      },
    );
  }, [projectId, undoAcceptMutation, workId, threadId]);

  const confirmDiscardOperation = useCallback((operationId: string) => {
    dispatch({ type: "confirmDiscardOperation", operationId });
  }, []);

  const cancelDiscardOperation = useCallback(() => {
    dispatch({ type: "cancelDiscardOperation" });
  }, []);

  const discardOperation = useCallback(
    async (operationId: string) => {
      const runtime = inlineRuntimeRef.current;
      if (!runtime?.draftId || inlineDiscardIsPending(stateRef.current, runtime.draftId)) return;
      if (!discardCanStart(stateRef.current, runtime.draftId)) return;
      dispatch({ type: "discardStarted", draftId: runtime.draftId, operationId });
      try {
        const outcome = await rejectInlineReviewOperation({
          ...runtime,
          operationId,
          queryClient,
          journalCache: journalCacheRef.current,
        });
        if (outcome.status !== "applied") {
          dispatch({
            type: "discardFailed",
            draftId: runtime.draftId,
            operationId,
            code: codeForRejectOutcome(outcome),
          });
          return;
        }
        // The reject module refetches the preview (card list); the group's
        // `+N −N` totals come from `useWorkDrafts`, so refresh that too or the
        // header stays stale until the next whole-draft action.
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDrafts(projectId, workId),
        });
        // Stickiness backstop: the inverse synced, but the settle signal comes
        // from the next preview refetch dropping the operation. If that never
        // arrives, surface an error rather than leaving the card stuck pending.
        const timer = window.setTimeout(() => {
          pendingDiscardTimersRef.current.delete(discardTimerKey(runtime.draftId, operationId));
          if (!pendingDiscardIdsForDraft(stateRef.current, runtime.draftId).has(operationId))
            return;
          dispatch({
            type: "discardFailed",
            draftId: runtime.draftId,
            operationId,
            code: "discard-not-settled",
          });
        }, 4500);
        pendingDiscardTimersRef.current.set(discardTimerKey(runtime.draftId, operationId), timer);
      } catch {
        dispatch({
          type: "discardFailed",
          draftId: runtime.draftId,
          operationId,
          code: "discard-offline",
        });
      }
    },
    [queryClient, projectId, workId],
  );

  const accept = useCallback(
    async (
      documentId: string,
      draftId: string,
      options?: { confirmedLiveRevisionToken?: number },
    ) => {
      if (
        acceptIsBlocked({
          isPending,
          isInlineDiscardPending: inlineDiscardIsPending(stateRef.current),
          isOperationAccepting: operationAcceptMutation.isPending,
          isOperationUndoing: undoAcceptMutation.isPending,
          isCannotPlaceTerminal:
            stateRef.current.cannotPlaceDraft?.documentId === documentId &&
            stateRef.current.cannotPlaceDraft.draftId === draftId,
        })
      ) {
        return;
      }
      const needsOverlapConfirm = overlap?.draftId === draftId;
      await waitForDraftDocumentSync(draftId);
      const { draftRevisionToken, branchId } = await latestPreviewRevisionTokens(
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
          branchId,
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
    [
      acceptMutation,
      isPending,
      operationAcceptMutation,
      undoAcceptMutation,
      overlap,
      queryClient,
      projectId,
      workId,
      threadId,
    ],
  );

  const reject = useCallback(
    async (documentId: string, draftId: string) => {
      // Discard all joins the disposition lock: no whole-draft reject while any
      // per-card Apply/Discard (or whole-draft accept) is mid-flight.
      if (isDisposing) return;
      const { branchId } = await latestPreviewRevisionTokens(
        queryClient,
        projectId,
        workId,
        documentId,
        draftId,
      );
      rejectMutation.mutate(
        { projectId, workId, threadId, documentId, draftId, branchId },
        {
          onSuccess() {
            dispatch({ type: "rejectSucceeded", draftId });
          },
        },
      );
    },
    [isDisposing, rejectMutation, queryClient, projectId, workId, threadId],
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
      isInlineDiscardPending,
      isOperationAccepting,
      isOperationUndoing,
      isDisposing,
      pendingInlineDiscardIds,
      cannotPlaceInlineOperationIds,
      acceptingOperationId,
      confirmingAcceptOperationId,
      confirmingDiscardOperationId,
      inlineReviewMessage,
      inlineDiscardError,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      focusReviewOperation,
      confirmAcceptOperation,
      cancelAcceptOperation,
      acceptOperation,
      undoAcceptOperation,
      confirmDiscardOperation,
      cancelDiscardOperation,
      discardOperation,
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
      isInlineDiscardPending,
      isOperationAccepting,
      isOperationUndoing,
      isDisposing,
      pendingInlineDiscardIds,
      cannotPlaceInlineOperationIds,
      acceptingOperationId,
      confirmingAcceptOperationId,
      confirmingDiscardOperationId,
      inlineReviewMessage,
      inlineDiscardError,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      focusReviewOperation,
      confirmAcceptOperation,
      cancelAcceptOperation,
      acceptOperation,
      undoAcceptOperation,
      confirmDiscardOperation,
      cancelDiscardOperation,
      discardOperation,
      accept,
      reject,
    ],
  );
}

const ACCEPT_SYNC_WAIT_MS = 1500;

type DraftPreviewRevisionTokens = {
  draftRevisionToken: number;
  liveRevisionToken: number | null;
  branchId?: string;
};

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
        ...(preview.branchId ? { branchId: preview.branchId } : {}),
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

function clearPendingDiscardTimer(
  timers: Map<string, number>,
  draftId: string,
  operationId: string,
): void {
  const key = discardTimerKey(draftId, operationId);
  const timer = timers.get(key);
  if (timer == null) return;
  window.clearTimeout(timer);
  timers.delete(key);
}

function discardTimerKey(draftId: string, operationId: string): string {
  return `${draftId}:${operationId}`;
}

function codeForRejectOutcome(outcome: InlineReviewRejectOutcome): InlineReviewMessageCode {
  switch (outcome.status) {
    case "stale":
      return "discard-stale";
    case "finalized":
      return "discard-finalized";
    case "offline":
      return "discard-offline";
    default:
      return "discard-failed";
  }
}

function operationAcceptRequest(input: {
  draftId: string;
  draftRevisionToken: number;
  operationId: string;
  acceptClosureOperationIds?: readonly string[];
  liveRevisionToken?: number;
  confirmClosure: boolean;
  overlap: DraftReviewOverlap | null;
}): {
  draftId: string;
  draftRevisionToken: number;
  operationIds: string[];
  confirmedClosureOperationIds?: string[];
  confirmOverlap?: boolean;
  confirmedLiveRevisionToken?: number;
} {
  const closureOperationIds = input.acceptClosureOperationIds ?? [input.operationId];
  const confirmedClosureOperationIds = input.confirmClosure ? [...closureOperationIds] : undefined;
  return {
    draftId: input.draftId,
    draftRevisionToken: input.draftRevisionToken,
    operationIds: [input.operationId],
    confirmedClosureOperationIds,
    confirmOverlap: input.overlap != null ? true : undefined,
    confirmedLiveRevisionToken: input.overlap
      ? (input.overlap.liveRevisionToken ?? input.liveRevisionToken)
      : input.confirmClosure
        ? input.liveRevisionToken
        : undefined,
  };
}

function operationOverlapFor(
  overlap: DraftReviewOverlap | null,
  draftId: string,
  operationId: string,
): DraftReviewOverlap | null {
  return overlap?.draftId === draftId && overlap.operationId === operationId ? overlap : null;
}
