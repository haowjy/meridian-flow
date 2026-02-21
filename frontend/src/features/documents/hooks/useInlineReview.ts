/**
 * useInlineReview — wires the CM6 inline review extension to the collab data
 * pipeline, handling:
 * - Accept/reject individual hunks (applyHunkUpdate + CM6 state effect)
 * - Accept/reject all pending hunks
 * - Auto-finalization: when all hunks for a proposal are resolved, send
 *   proposal accept or reject via WebSocket
 * - Hunk navigation (prev/next)
 * - pendingProposalId consumption (auto-select proposal from thread)
 *
 * CM6 StateField is the single source of truth for hunks, resolutions, and
 * active hunk index. React only tracks a version counter to trigger toolbar
 * re-renders + the set of active proposal IDs (not in CM6 state).
 *
 * IMPORTANT: The extension array must be stable across re-renders because
 * CodeMirrorEditor only reads extensions on mount (empty deps useEffect).
 * We use callback refs so the ViewPlugin/keymap always call the latest
 * handlers without needing to recreate the extension array.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeMirrorEditorRef } from "@/core/editor/codemirror";
import { useUIStore } from "@/core/stores/useUIStore";
import { makeLogger } from "@/core/lib/logger";
import {
  inlineReviewExtension,
  setReviewHunksEffect,
  clearReviewEffect,
  resolveHunkEffect,
  setActiveHunkIndex,
  getInlineReviewState,
  startHunkEditSession,
  updateHunkEditSession,
  commitHunkEditSession,
  type HunkEditSession,
  type ReviewHunk,
  type ProposalOperationsModel,
} from "@/core/cm6-collab";

const log = makeLogger("use-inline-review");

// ============================================================================
// TYPES
// ============================================================================

interface UseInlineReviewOptions {
  editorRef: React.RefObject<CodeMirrorEditorRef | null>;
  collabEnabled: boolean;
  operationsModels: Map<string, ProposalOperationsModel>;
  applyHunkUpdate: (
    hunk: ReviewHunk,
    editedInsertedText?: string,
  ) => { ok: boolean };
  sendProposalAccept: (proposalId: string, idempotencyKey: string) => boolean;
  sendProposalReject: (proposalId: string) => boolean;
  /** Lazy-fetch yjsUpdate for a proposal that was loaded via snapshot (no yjsUpdate). */
  requestProposalUpdate?: (proposalId: string) => boolean;
}

interface UseInlineReviewResult {
  /** CM6 extension array — include in editor extensions */
  extensions: Extension[];
  /** Props to pass to ProposalReviewToolbar */
  toolbarProps: {
    totalHunks: number;
    activeHunkIndex: number;
    resolvedCount: number;
    onKeepAll: () => void;
    onDiscardAll: () => void;
    onPrevHunk: () => void;
    onNextHunk: () => void;
  };
  /** Props to pass to ProposalHunkEditDialog */
  editDialogProps: {
    editSession: HunkEditSession | null;
    onUpdateDraft: (draftText: string) => void;
    onCommit: () => void;
    onCancel: () => void;
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/** Get all review hunks from ready operations models */
function collectReadyHunks(
  operationsModels: Map<string, ProposalOperationsModel>,
): { proposalId: string; hunks: ReviewHunk[] }[] {
  const result: { proposalId: string; hunks: ReviewHunk[] }[] = [];
  for (const [proposalId, model] of operationsModels) {
    if (model.availability === "ready" && model.hunks.length > 0) {
      result.push({ proposalId, hunks: model.hunks });
    }
  }
  return result;
}

/** Scroll editor to a document position */
function scrollToPos(view: EditorView, pos: number): void {
  const clampedPos = Math.min(pos, view.state.doc.length);
  view.dispatch({
    effects: EditorView.scrollIntoView(clampedPos, { y: "center" }),
  });
}

/**
 * Trigger a brief flash on the next active hunk's inserted block widget
 * (or the editor container as fallback) after a per-hunk resolve action.
 * Anchors the writer's eye to the new focus point after content shifts.
 * Purely presentational — no state change, no delay on resolve.
 */
function triggerResolveFeedback(view: EditorView): void {
  requestAnimationFrame(() => {
    // Find the next active hunk's inserted block in the DOM
    const target =
      view.dom.querySelector(".cm-review-active-hunk.cm-review-inserted-block") ??
      view.dom.querySelector(".cm-review-active-hunk");
    if (!target) return;

    target.classList.add("cm-review-resolve-flash");
    target.addEventListener(
      "animationend",
      () => target.classList.remove("cm-review-resolve-flash"),
      { once: true },
    );
  });
}

// ============================================================================
// HOOK
// ============================================================================

export function useInlineReview({
  editorRef,
  collabEnabled,
  operationsModels,
  applyHunkUpdate,
  // sendProposalAccept is intentionally unused — inline hunk review applies
  // edits via Yjs sync, so we always close proposals with reject (Bug 3 fix).
  sendProposalReject,
  requestProposalUpdate,
}: UseInlineReviewOptions): UseInlineReviewResult {
  // Proposal IDs for the current review session — needed for finalization
  // (not tracked in CM6 state since it's proposal-level, not hunk-level)
  const activeProposalIdsRef = useRef<Set<string>>(new Set());

  // Guard: suppress re-sync while a hunk is being resolved.
  // Accepting a hunk mutates the Yjs doc → reviewRevision++ → the sync effect
  // would re-dispatch setReviewHunksEffect and wipe the just-recorded resolution.
  // We set this flag before resolve and clear it via queueMicrotask so the
  // synchronous effect triggered by the same Yjs update is skipped.
  const isResolvingRef = useRef(false);

  // Track proposals we've already requested yjsUpdate for to avoid duplicate requests
  const requestedUpdatesRef = useRef<Set<string>>(new Set());

  // Version counter — incremented on every CM6 state mutation to trigger
  // toolbar re-render and re-read of CM6 state for toolbar props.
  // The value itself is unused; its presence in useMemo deps forces re-computation.
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Helper: get EditorView from ref (only call in event handlers / effects)
  const getView = useCallback((): EditorView | null => {
    return editorRef.current?.getView() ?? null;
  }, [editorRef]);

  // ------------------------------------------------------------------
  // Callback refs — keep latest handlers available to the stable CM6
  // extension without recreating it. CodeMirrorEditor only reads
  // extensions on mount, so the extension array MUST be stable.
  // ------------------------------------------------------------------

  const acceptHunkRef = useRef<(hunk: ReviewHunk) => void>(() => {});
  const rejectHunkRef = useRef<(hunk: ReviewHunk) => void>(() => {});
  const editHunkRef = useRef<(hunk: ReviewHunk) => void>(() => {});

  // Edit session state — tracks the hunk being edited in the dialog.
  // null = no edit dialog open.
  const [editSession, setEditSession] = useState<HunkEditSession | null>(null);
  // Ref to the hunk being edited — needed for commit to access the original
  // ReviewHunk object (which has baseStart/baseEnd for partial apply).
  const editingHunkRef = useRef<ReviewHunk | null>(null);

  // ------------------------------------------------------------------
  // Auto-finalization helper
  // ------------------------------------------------------------------

  /**
   * Check if all hunks are resolved. If so, send accept/reject per proposal
   * and clear review state. Called directly from accept/reject handlers —
   * reads CM6 state as source of truth.
   */
  const maybeAutoFinalize = useCallback(
    (view: EditorView) => {
      const state = getInlineReviewState(view.state);
      if (!state || state.hunks.length === 0) return;

      const allResolved = state.hunks.every((c) => state.resolutions.has(c.id));
      if (!allResolved) return;

      log.info("All hunks resolved, auto-finalizing", {
        total: state.hunks.length,
        accepted: [...state.resolutions.values()].filter(
          (s) => s === "accepted",
        ).length,
        rejected: [...state.resolutions.values()].filter(
          (s) => s === "rejected",
        ).length,
      });

      // Group resolutions by proposal
      const perProposal = new Map<
        string,
        { accepted: number; rejected: number }
      >();
      for (const hunk of state.hunks) {
        const status = state.resolutions.get(hunk.id);
        if (!status) continue;
        const cur = perProposal.get(hunk.proposalId) ?? {
          accepted: 0,
          rejected: 0,
        };
        if (status === "accepted") cur.accepted++;
        else cur.rejected++;
        perProposal.set(hunk.proposalId, cur);
      }

      // Always send reject to close the proposal — hunk edits are already
      // applied to the Yjs doc and synced to the server via collab transport.
      // Sending accept would cause the server to re-apply the full yjsUpdate,
      // duplicating the accepted text (Bug 3: double-apply).
      for (const [proposalId, counts] of perProposal) {
        sendProposalReject(proposalId);
        log.info("Closed proposal after inline hunk review", {
          proposalId,
          acceptedHunks: counts.accepted,
          rejectedHunks: counts.rejected,
        });
      }

      // Clear review state
      clearReviewEffect(view);
      activeProposalIdsRef.current = new Set();
      bump();
    },
    [sendProposalReject, bump],
  );

  // ------------------------------------------------------------------
  // Accept/reject hunk handlers
  // ------------------------------------------------------------------

  const handleAcceptHunk = useCallback(
    (hunk: ReviewHunk) => {
      // Suppress re-sync while resolving — accepting mutates the Yjs doc
      // which triggers reviewRevision++ and the sync effect. Without this
      // guard the sync effect would re-dispatch setReviewHunks and could
      // produce phantom hunks from the mutated doc.
      isResolvingRef.current = true;

      const { ok } = applyHunkUpdate(hunk);
      if (!ok) {
        log.warn("Failed to apply hunk update", { hunkId: hunk.id });
        isResolvingRef.current = false;
        return;
      }
      const view = getView();
      if (!view) {
        isResolvingRef.current = false;
        return;
      }

      resolveHunkEffect(view, hunk.id, "accepted");
      bump();
      triggerResolveFeedback(view);
      maybeAutoFinalize(view);

      // Clear after microtask so the synchronous effect from the same
      // Yjs update cycle is still suppressed
      queueMicrotask(() => {
        isResolvingRef.current = false;
      });
    },
    [applyHunkUpdate, getView, bump, maybeAutoFinalize],
  );

  const handleRejectHunk = useCallback(
    (hunk: ReviewHunk) => {
      isResolvingRef.current = true;

      const view = getView();
      if (!view) {
        isResolvingRef.current = false;
        return;
      }

      resolveHunkEffect(view, hunk.id, "rejected");
      bump();
      triggerResolveFeedback(view);
      maybeAutoFinalize(view);

      queueMicrotask(() => {
        isResolvingRef.current = false;
      });
    },
    [getView, bump, maybeAutoFinalize],
  );

  // ------------------------------------------------------------------
  // Edit hunk handlers
  // ------------------------------------------------------------------

  /** Open the edit dialog for a hunk — prefills with its insertedText */
  const handleEditHunk = useCallback((hunk: ReviewHunk) => {
    editingHunkRef.current = hunk;
    setEditSession(startHunkEditSession(hunk));
    log.info("Opened edit dialog for hunk", { hunkId: hunk.id });
  }, []);

  /** Update draft text while editing (controlled input) */
  const handleUpdateDraft = useCallback((draftText: string) => {
    setEditSession((prev) =>
      prev ? updateHunkEditSession(prev, draftText) : null,
    );
  }, []);

  /** Commit the edit: apply edited text, resolve hunk, auto-finalize */
  const handleCommitEdit = useCallback(() => {
    if (!editSession) return;
    const hunk = editingHunkRef.current;
    if (!hunk) return;

    const commit = commitHunkEditSession(editSession);

    // Suppress re-sync while resolving (same guard as handleAcceptHunk)
    isResolvingRef.current = true;

    // Only pass editedText when the user actually changed something.
    // When wasEdited is false, use the same code path as "Keep" (no edited
    // text arg) so semantics are identical to handleAcceptHunk.
    const { ok } = commit.wasEdited
      ? applyHunkUpdate(hunk, commit.insertedText)
      : applyHunkUpdate(hunk);
    if (!ok) {
      log.warn("Failed to apply edited hunk update", { hunkId: hunk.id });
      isResolvingRef.current = false;
      return;
    }

    const view = getView();
    if (!view) {
      isResolvingRef.current = false;
      return;
    }

    resolveHunkEffect(view, hunk.id, "accepted");
    bump();
    maybeAutoFinalize(view);

    // Clear edit session
    setEditSession(null);
    editingHunkRef.current = null;

    log.info("Committed edited hunk", {
      hunkId: hunk.id,
      wasEdited: commit.wasEdited,
    });

    queueMicrotask(() => {
      isResolvingRef.current = false;
    });
  }, [editSession, applyHunkUpdate, getView, bump, maybeAutoFinalize]);

  /** Cancel the edit dialog — no document change, no resolution */
  const handleCancelEdit = useCallback(() => {
    setEditSession(null);
    editingHunkRef.current = null;
    log.info("Cancelled hunk edit");
  }, []);

  // Keep refs in sync with latest callback versions
  acceptHunkRef.current = handleAcceptHunk;
  rejectHunkRef.current = handleRejectHunk;
  editHunkRef.current = handleEditHunk;

  // ------------------------------------------------------------------
  // Batch actions
  // ------------------------------------------------------------------

  const handleAcceptAll = useCallback(() => {
    const view = getView();
    if (!view) return;

    const state = getInlineReviewState(view.state);
    if (!state) return;

    const pending = state.hunks.filter((c) => !state.resolutions.has(c.id));
    for (const hunk of pending) {
      const { ok } = applyHunkUpdate(hunk);
      if (ok) {
        resolveHunkEffect(view, hunk.id, "accepted");
      }
    }

    // Send reject to close each proposal — hunk edits are already in the
    // Yjs doc and synced via collab transport. Accept would re-apply the
    // full yjsUpdate, duplicating text (Bug 3: double-apply).
    for (const proposalId of activeProposalIdsRef.current) {
      sendProposalReject(proposalId);
    }

    // Clear review state
    clearReviewEffect(view);
    activeProposalIdsRef.current = new Set();
    bump();
  }, [applyHunkUpdate, getView, sendProposalReject, bump]);

  const handleRejectAll = useCallback(() => {
    const view = getView();
    if (!view) return;

    // Send reject for each active proposal
    for (const proposalId of activeProposalIdsRef.current) {
      sendProposalReject(proposalId);
    }

    // Clear review state
    clearReviewEffect(view);
    activeProposalIdsRef.current = new Set();
    bump();
  }, [getView, sendProposalReject, bump]);

  // ------------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------------

  const handlePrevHunk = useCallback(() => {
    const view = getView();
    if (!view) return;

    const state = getInlineReviewState(view.state);
    if (!state || state.hunks.length === 0) return;

    const len = state.hunks.length;
    for (let step = 1; step <= len; step++) {
      const idx = (((state.activeHunkIndex - step) % len) + len) % len;
      if (!state.resolutions.has(state.hunks[idx]!.id)) {
        setActiveHunkIndex(view, idx);
        scrollToPos(view, state.hunks[idx]!.baseStart);
        bump();
        return;
      }
    }
  }, [getView, bump]);

  const handleNextHunk = useCallback(() => {
    const view = getView();
    if (!view) return;

    const state = getInlineReviewState(view.state);
    if (!state || state.hunks.length === 0) return;

    const len = state.hunks.length;
    for (let step = 1; step <= len; step++) {
      const idx = (state.activeHunkIndex + step) % len;
      if (!state.resolutions.has(state.hunks[idx]!.id)) {
        setActiveHunkIndex(view, idx);
        scrollToPos(view, state.hunks[idx]!.baseStart);
        bump();
        return;
      }
    }
  }, [getView, bump]);

  // ------------------------------------------------------------------
  // Extension — MUST be stable across re-renders because
  // CodeMirrorEditor only reads extensions on mount (empty deps useEffect).
  // Callbacks go through refs so they always call the latest handler.
  // ------------------------------------------------------------------

  const extensions = useMemo((): Extension[] => {
    if (!collabEnabled) return [];
    return inlineReviewExtension({
      onAcceptHunk: (hunk) => acceptHunkRef.current(hunk),
      onRejectHunk: (hunk) => rejectHunkRef.current(hunk),
      onEditHunk: (hunk) => editHunkRef.current(hunk),
    });
    // Only depends on collabEnabled — callbacks go through stable refs
  }, [collabEnabled]);

  // ------------------------------------------------------------------
  // Sync operationsModels → CM6 state (dispatch setReviewHunks)
  // ------------------------------------------------------------------

  useEffect(() => {
    if (!collabEnabled) return;

    const view = getView();
    if (!view) return;

    // Check that the inlineReviewField is present in the editor state
    const currentState = getInlineReviewState(view.state);
    if (!currentState) {
      log.warn(
        "Sync effect: inlineReviewField NOT found in editor state — extension not registered",
      );
      return;
    }

    // Skip re-sync while a hunk is being resolved — the Yjs mutation from
    // accept triggers reviewRevision++ which re-runs this effect. Re-deriving
    // hunks against the mutated doc would produce phantom diffs (Bug 4) and
    // wipe the just-recorded resolution (Bug 2).
    if (isResolvingRef.current) {
      return;
    }

    const readyGroups = collectReadyHunks(operationsModels);
    const allHunks = readyGroups.flatMap((g) => g.hunks);
    const proposalIds = new Set(readyGroups.map((g) => g.proposalId));

    activeProposalIdsRef.current = proposalIds;

    if (allHunks.length > 0) {
      setReviewHunksEffect(view, allHunks);
      log.info("Loaded review hunks into editor", {
        count: allHunks.length,
        proposals: readyGroups.map((g) => g.proposalId),
      });
    } else {
      // Don't clear on transient unavailability — proposals may still be
      // loading their yjsUpdate (snapshot reload) or hit a temporary apply
      // error. Only clear when there are genuinely no active proposals.
      const hasProposalsLoading = [...operationsModels.values()].some(
        (m) =>
          m.availability === "ready" ||
          (m.availability === "unavailable" && m.reason === "missing_update"),
      );
      if (!hasProposalsLoading) {
        clearReviewEffect(view);
      }
    }
    bump();
  }, [collabEnabled, getView, operationsModels, bump]);

  // ------------------------------------------------------------------
  // Auto-request missing yjsUpdate for snapshot-loaded proposals
  // ------------------------------------------------------------------

  useEffect(() => {
    if (!collabEnabled || !requestProposalUpdate) return;

    for (const [proposalId, model] of operationsModels) {
      if (
        model.availability === "unavailable" &&
        model.reason === "missing_update" &&
        !requestedUpdatesRef.current.has(proposalId)
      ) {
        log.info("Auto-requesting yjsUpdate for proposal", {
          proposalId,
          reason: model.reason,
          message: model.message,
        });
        const sent = requestProposalUpdate(proposalId);
        if (sent) {
          // Only mark as requested if the command was actually sent.
          // If WS isn't connected yet, we'll retry on the next effect run.
          requestedUpdatesRef.current.add(proposalId);
        } else {
          log.warn("Failed to send yjsUpdate request — will retry", {
            proposalId,
          });
        }
      }
    }
  }, [collabEnabled, operationsModels, requestProposalUpdate]);

  // ------------------------------------------------------------------
  // pendingProposalId consumption
  // ------------------------------------------------------------------

  useEffect(() => {
    if (!collabEnabled) return;

    const pendingId = useUIStore.getState().pendingProposalId;
    if (!pendingId) return;

    // Check if this proposal has ready operations
    const model = operationsModels.get(pendingId);
    if (!model || model.availability !== "ready") return;

    const view = getView();
    if (!view) return;

    // Already loaded via the sync effect above — just scroll to first hunk
    if (model.hunks.length > 0) {
      scrollToPos(view, model.hunks[0]!.baseStart);
    }

    // Consume the pending ID
    useUIStore.getState().setPendingProposalId(null);
    log.info("Consumed pendingProposalId", { proposalId: pendingId });
  }, [collabEnabled, getView, operationsModels]);

  // ------------------------------------------------------------------
  // Toolbar props — read from CM6 state (source of truth)
  // ------------------------------------------------------------------

  const toolbarProps = useMemo(() => {
    const view = getView();
    const state = view ? getInlineReviewState(view.state) : null;

    return {
      totalHunks: state?.hunks.length ?? 0,
      activeHunkIndex: state?.activeHunkIndex ?? -1,
      resolvedCount: state?.resolutions.size ?? 0,
      onKeepAll: handleAcceptAll,
      onDiscardAll: handleRejectAll,
      onPrevHunk: handlePrevHunk,
      onNextHunk: handleNextHunk,
    };
    // version is a render trigger — its value is unused, but its change forces
    // re-computation so toolbar reads fresh CM6 state after each mutation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    version,
    getView,
    handleAcceptAll,
    handleRejectAll,
    handlePrevHunk,
    handleNextHunk,
  ]);

  const editDialogProps = useMemo(
    () => ({
      editSession,
      onUpdateDraft: handleUpdateDraft,
      onCommit: handleCommitEdit,
      onCancel: handleCancelEdit,
    }),
    [editSession, handleUpdateDraft, handleCommitEdit, handleCancelEdit],
  );

  return { extensions, toolbarProps, editDialogProps };
}
