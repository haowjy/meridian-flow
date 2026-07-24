/**
 * useDraftReviewController — shared state machine for reviewing AI document drafts.
 *
 * The dock Changes cards and editor header both address the same inline review
 * session; this controller keeps whole-draft apply/discard, per-card
 * Apply/Discard, review closure, and editor focus state on one
 * path so review surfaces cannot drift. Per-card Apply routes the closure-aware
 * `acceptDraft` mutation with `operationIds`; per-card Discard routes through
 * the same server-backed discard mutation with `operationIds`.
 */

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type * as Y from "yjs";
import { getDraftPreview } from "@/client/api/drafts-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  useAcceptDraft,
  useRejectDraft,
  useUndoDraftAccept,
} from "@/client/query/useDraftReviewMutations";
import { useContextTabsStore } from "@/client/stores";
import type { InlineReviewModel } from "@/core/editor/extensions/inline-review";
import {
  conflictForSelection,
  type DraftApplyOutcome,
  type DraftApplyPreview,
  type DraftApplyRefusal,
  type DraftCommandOutcome,
  type DraftReviewCommandPorts,
  type DraftReviewSelection,
  DraftReviewSession,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  type InlineReviewMessage,
  type InlineReviewMessageCode,
  inlineReviewFromState,
} from "./draft-review-session";

export type { DraftReviewSelection, InlineDraftReview, InlineReviewMessageCode };

/**
 * The single review-runtime claim. It carries the active draft identifiers and
 * doc so any review surface can route server-backed per-card dispositions.
 * Registration is claim-based
 * on the editor identity (see register/release below).
 */
export type InlineReviewRuntime = {
  editor: Editor;
  draftDoc: Y.Doc;
  projectId: string;
  workId: string;
  documentId: string;
  draftId: string;
};

export type DraftReviewController = {
  projectId: string;
  workId: string;
  /** Focused thread owning this review surface; threads accept/reject/undo cache invalidation. */
  threadId: string | null;
  inlineReview: InlineDraftReview | null;
  reviewRoomName: string | null;
  reviewRoomError: boolean;
  staleDraft: DraftReviewSelection | null;
  staleDraftMessage: string | null;
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
  /** The operation whose per-card Apply is in flight, or null. */
  acceptingOperationId: string | null;
  inlineReviewMessage: InlineReviewMessage | null;
  inlineDiscardError: InlineReviewMessageCode | null;
  needsRereview: boolean;
  conflictedBlocks: ReadonlySet<string>;
  applyRefusal: DraftApplyRefusal | null;
  enterInlineReview: (documentId: string, draftId: string) => void;
  exitInlineReview: () => void;
  exitReview: () => void;
  inlineReviewModelAvailable: (
    identity: string,
    documentId: string,
    draftId: string,
    operationIds: readonly string[],
    revision: { draftRevisionToken: number; branchId?: string },
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
  acceptOperation: (operationId: string, model: InlineReviewModel) => Promise<DraftCommandOutcome>;
  undoAcceptOperation: () => Promise<DraftCommandOutcome>;
  discardOperation: (operationId: string) => Promise<DraftCommandOutcome>;
  accept: (documentId: string, draftId: string) => Promise<DraftCommandOutcome>;
  reject: (documentId: string, draftId: string) => Promise<DraftCommandOutcome>;
  disposeDrafts: (
    mode: "apply" | "discard",
    drafts: readonly DraftReviewSelection[],
  ) => Promise<DraftCommandOutcome[]>;
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
  const commandPortsRef = useRef<DraftReviewCommandPorts | null>(null);
  const reviewSession = useMemo(
    () =>
      new DraftReviewSession(() => {
        const ports = commandPortsRef.current;
        if (!ports) throw new Error("Draft review command ports are not ready.");
        return ports;
      }),
    [],
  );
  const dispositionLock = reviewSession.disposition;
  const disposition = useSyncExternalStore(
    dispositionLock.subscribe,
    dispositionLock.getSnapshot,
    dispositionLock.getSnapshot,
  );
  const [reviewRoomName, setReviewRoomName] = useState<string | null>(null);
  const [reviewRoomError, setReviewRoomError] = useState(false);
  const stateRef = useRef(state);
  const inlineRuntimeRef = useRef<InlineReviewRuntime | null>(null);
  const displayedPreviewRef = useRef<(DraftApplyPreview & { identity: string }) | null>(null);
  const activeReviewRequestRef = useRef<(DraftReviewSelection & { attemptId: number }) | null>(
    null,
  );
  const nextReviewAttemptIdRef = useRef(0);
  stateRef.current = state;

  const inlineReview = inlineReviewFromState(state);
  const staleDraft = state.staleDraft;
  const acceptingOperationId =
    disposition.phase !== "idle" && disposition.target.kind === "apply-operation"
      ? disposition.target.operationId
      : null;
  const inlineReviewMessage = state.inlineReviewMessage;
  const inlineDiscardError = state.inlineDiscardError;
  const applyRefusal = state.applyRefusal;
  const concurrentConflict = conflictForSelection(state, inlineReview);
  const needsRereview = concurrentConflict !== null;
  const conflictedBlocks = useMemo(
    () => new Set(concurrentConflict?.conflictedBlocks ?? []),
    [concurrentConflict],
  );

  const staleDraftMessage = staleDraft
    ? "The draft changed — review the latest changes before applying."
    : null;
  const activeDisposition = disposition.phase === "idle" ? null : disposition.target;
  const isAccepting = activeDisposition?.kind === "apply-draft";
  const isRejecting = activeDisposition?.kind === "discard-draft";
  const isOperationAccepting = activeDisposition?.kind === "apply-operation";
  const isOperationUndoing = activeDisposition?.kind === "undo-operation";
  const isInlineDiscardPending = activeDisposition?.kind === "discard-operation";
  const isPending = isAccepting || isRejecting;
  const isDisposing = disposition.phase !== "idle";
  const pendingInlineDiscardIds = useCallback(
    (draftId: string | null | undefined): ReadonlySet<string> =>
      activeDisposition?.kind === "discard-operation" && activeDisposition.draftId === draftId
        ? new Set([activeDisposition.operationId])
        : EMPTY_OPERATION_IDS,
    [activeDisposition],
  );

  useEffect(() => {
    if (inlineReview) return;
    activeReviewRequestRef.current = null;
    setReviewRoomName(null);
    setReviewRoomError(false);
  }, [inlineReview]);

  const loadInlineReviewRoom = useCallback(
    (documentId: string, draftId: string) => {
      nextReviewAttemptIdRef.current += 1;
      const attemptId = nextReviewAttemptIdRef.current;
      activeReviewRequestRef.current = { documentId, draftId, attemptId };
      setReviewRoomName(null);
      setReviewRoomError(false);
      void getDraftPreview(projectId, workId, documentId, draftId)
        .then((preview) => {
          queryClient.setQueryData(
            projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
            preview,
          );
          const current = activeReviewRequestRef.current;
          if (
            current?.documentId !== documentId ||
            current.draftId !== draftId ||
            current.attemptId !== attemptId
          )
            return;
          if (preview.status === "active") setReviewRoomName(preview.reviewRoomName ?? null);
        })
        .catch(() => {
          const current = activeReviewRequestRef.current;
          if (
            current?.documentId !== documentId ||
            current.draftId !== draftId ||
            current.attemptId !== attemptId
          )
            return;
          void queryClient.invalidateQueries({
            queryKey: projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
          });
          setReviewRoomName(null);
          setReviewRoomError(true);
        });
    },
    [projectId, queryClient, workId],
  );

  const applyDisposition = useCallback(
    (documentId: string, draftId: string, outcome: DraftApplyOutcome) => {
      if (outcome.refreshDraftId) {
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
        });
        loadInlineReviewRoom(documentId, outcome.refreshDraftId);
      }
      dispatch({
        type: "applySucceeded",
        documentId,
        draftId,
        outcome,
      });
      if (outcome.message) {
        dispatch({
          type: "operationAcceptSucceeded",
          message: outcome.message,
        });
      }
      if (outcome.materializedDocument) {
        useContextTabsStore.getState().resolveDraftOnlyTab(projectId, documentId, "committed");
      }
    },
    [loadInlineReviewRoom, projectId, queryClient, workId],
  );

  commandPortsRef.current = {
    loadPreview: async ({ documentId, draftId }) => {
      const preview = await latestPreviewRevisionTokens(
        queryClient,
        projectId,
        workId,
        documentId,
        draftId,
      );
      return {
        documentId,
        draftId,
        operationIds: preview.operationIds,
        draftRevisionToken: preview.draftRevisionToken,
        ...(preview.branchId ? { branchId: preview.branchId } : {}),
      };
    },
    apply: ({ documentId }, scope, request) =>
      (scope === "operation" ? operationAcceptMutation : acceptMutation).mutateAsync({
        projectId,
        workId,
        threadId,
        documentId,
        ...request,
      }),
    discard: async ({ documentId, draftId }, input) => {
      await rejectMutation.mutateAsync({
        projectId,
        workId,
        threadId,
        documentId,
        draftId,
        ...input,
      });
    },
    undo: async ({ documentId, draftId }, writeId) => {
      await undoAcceptMutation.mutateAsync({
        projectId,
        workId,
        threadId,
        documentId,
        draftId,
        writeId,
      });
    },
    applyStarted: () => {
      dispatch({ type: "applyStarted" });
    },
    applySettled: ({ documentId, draftId }, outcome) => {
      applyDisposition(documentId, draftId, outcome);
    },
    draftDiscarded: ({ documentId, draftId }) => {
      dispatch({ type: "rejectSucceeded", draftId });
      useContextTabsStore.getState().resolveDraftOnlyTab(projectId, documentId, "discarded");
    },
  };

  const enterInlineReview = useCallback(
    (documentId: string, draftId: string) => {
      dispatch({ type: "enterInline", documentId, draftId });
      loadInlineReviewRoom(documentId, draftId);
    },
    [loadInlineReviewRoom],
  );

  const exitInlineReview = useCallback(() => {
    const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
    if (inline) {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workDraftPreview(
          projectId,
          workId,
          inline.documentId,
          inline.draftId,
        ),
      });
    }
    activeReviewRequestRef.current = null;
    setReviewRoomName(null);
    setReviewRoomError(false);
    dispatch({ type: "exitInline" });
  }, [projectId, queryClient, workId]);

  const exitReview = useCallback(() => {
    activeReviewRequestRef.current = null;
    setReviewRoomName(null);
    setReviewRoomError(false);
    dispatch({ type: "exitReview" });
  }, []);

  const inlineReviewModelAvailable = useCallback(
    (
      identity: string,
      documentId: string,
      draftId: string,
      operationIds: readonly string[],
      revision: { draftRevisionToken: number; branchId?: string },
    ) => {
      displayedPreviewRef.current = {
        identity,
        documentId,
        draftId,
        operationIds: [...operationIds],
        draftRevisionToken: revision.draftRevisionToken,
        ...(revision.branchId ? { branchId: revision.branchId } : {}),
      };
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

  const acceptOperation = useCallback(
    async (operationId: string, model: InlineReviewModel): Promise<DraftCommandOutcome> => {
      const current = stateRef.current;
      const inline = current.surface.kind === "inline" ? current.surface : null;
      if (!inline) {
        dispatch({
          type: "operationAcceptFailed",
          message: { code: "open-review-first", tone: "error" },
        });
        return { kind: "failed", code: "open-review-first" };
      }
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
        return { kind: "failed", code: "change-moved" };
      }
      dispatch({ type: "operationAcceptStarted", operationId });
      const outcome = await reviewSession.applyOperation(inline, operationId);
      if (outcome.kind === "failed") {
        dispatch({
          type: "operationAcceptFailed",
          message: { code: outcome.code, tone: "error" },
        });
      }
      return outcome;
    },
    [projectId, queryClient, reviewSession, workId],
  );

  // Reverse the most recent per-card Apply. The `writeId` rides on the
  // "Change applied" message; undo is only offered while that message stands.
  const undoAcceptOperation = useCallback(async (): Promise<DraftCommandOutcome> => {
    const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
    const writeId = stateRef.current.inlineReviewMessage?.writeId;
    if (!inline || !writeId) return { kind: "failed", code: "undo-failed" };
    const outcome = await reviewSession.undoOperation(inline, writeId);
    if (outcome.kind === "undone") {
      dispatch({
        type: "operationUndoAcceptSucceeded",
        message: { code: "change-restored" },
      });
    } else if (outcome.kind === "failed") {
      dispatch({
        type: "operationUndoAcceptFailed",
        message: { code: "undo-failed", tone: "error" },
      });
    }
    return outcome;
  }, [reviewSession]);

  const discardOperation = useCallback(
    async (operationId: string): Promise<DraftCommandOutcome> => {
      const runtime = inlineRuntimeRef.current;
      if (!runtime?.draftId) return { kind: "failed", code: "discard-failed" };
      dispatch({ type: "discardStarted" });
      const outcome = await reviewSession.discardOperation(runtime, operationId);
      if (outcome.kind === "failed") {
        dispatch({
          type: "discardFailed",
          code: outcome.code,
        });
      }
      return outcome;
    },
    [reviewSession],
  );

  const accept = useCallback(
    async (documentId: string, draftId: string): Promise<DraftCommandOutcome> => {
      const displayedPreview = displayedPreviewRef.current;
      if (
        !displayedPreview ||
        displayedPreview.documentId !== documentId ||
        displayedPreview.draftId !== draftId ||
        displayedPreview.operationIds.length === 0
      ) {
        return { kind: "failed", code: "apply-failed" };
      }
      return reviewSession.applyReviewedDraft({ documentId, draftId }, displayedPreview);
    },
    [reviewSession],
  );

  const reject = useCallback(
    (documentId: string, draftId: string): Promise<DraftCommandOutcome> =>
      reviewSession.discardDraft({ documentId, draftId }),
    [reviewSession],
  );

  const disposeDrafts = useCallback(
    (
      mode: "apply" | "discard",
      drafts: readonly DraftReviewSelection[],
    ): Promise<DraftCommandOutcome[]> => reviewSession.disposeDrafts(mode, drafts),
    [reviewSession],
  );

  return useMemo(
    () => ({
      projectId,
      workId,
      threadId,
      inlineReview,
      reviewRoomName,
      reviewRoomError,
      staleDraft,
      staleDraftMessage,
      isAccepting,
      isRejecting,
      isPending,
      isInlineDiscardPending,
      isOperationAccepting,
      isOperationUndoing,
      isDisposing,
      pendingInlineDiscardIds,
      acceptingOperationId,
      inlineReviewMessage,
      inlineDiscardError,
      needsRereview,
      conflictedBlocks,
      applyRefusal,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      focusReviewOperation,
      acceptOperation,
      undoAcceptOperation,
      discardOperation,
      accept,
      reject,
      disposeDrafts,
    }),
    [
      projectId,
      workId,
      threadId,
      inlineReview,
      reviewRoomName,
      reviewRoomError,
      staleDraft,
      staleDraftMessage,
      isAccepting,
      isRejecting,
      isPending,
      isInlineDiscardPending,
      isOperationAccepting,
      isOperationUndoing,
      isDisposing,
      pendingInlineDiscardIds,
      acceptingOperationId,
      inlineReviewMessage,
      inlineDiscardError,
      needsRereview,
      conflictedBlocks,
      applyRefusal,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      focusReviewOperation,
      acceptOperation,
      undoAcceptOperation,
      discardOperation,
      accept,
      reject,
      disposeDrafts,
    ],
  );
}

type DraftPreviewRevisionTokens = {
  draftRevisionToken: number;
  liveRevisionToken: number | null;
  operationIds: string[];
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
        operationIds: preview.operations.map((operation) => operation.operationId),
        ...(preview.branchId ? { branchId: preview.branchId } : {}),
      }
    : { draftRevisionToken: -1, liveRevisionToken: null, operationIds: [] };
}

const EMPTY_OPERATION_IDS = new Set<string>();
