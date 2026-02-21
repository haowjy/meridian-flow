/**
 * useInlineReview — wires the CM6 inline review extension to the collab data
 * pipeline, handling:
 * - Accept/reject individual chunks (applyChunkUpdate + CM6 state effect)
 * - Accept/reject all pending chunks
 * - Auto-finalization: when all chunks for a proposal are resolved, send
 *   proposal accept or reject via WebSocket
 * - Chunk navigation (prev/next)
 * - pendingProposalId consumption (auto-select proposal from thread)
 *
 * CM6 StateField is the single source of truth for chunks, resolutions, and
 * active chunk index. React only tracks a version counter to trigger toolbar
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
  setReviewChunksEffect,
  clearReviewEffect,
  resolveChunkEffect,
  setActiveChunkIndex,
  getInlineReviewState,
  type ReviewChunk,
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
  applyChunkUpdate: (
    chunk: ReviewChunk,
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
    totalChunks: number;
    activeChunkIndex: number;
    resolvedCount: number;
    onAcceptAll: () => void;
    onRejectAll: () => void;
    onPrevChunk: () => void;
    onNextChunk: () => void;
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/** Get all review chunks from ready operations models */
function collectReadyChunks(
  operationsModels: Map<string, ProposalOperationsModel>,
): { proposalId: string; chunks: ReviewChunk[] }[] {
  const result: { proposalId: string; chunks: ReviewChunk[] }[] = [];
  for (const [proposalId, model] of operationsModels) {
    if (model.availability === "ready" && model.chunks.length > 0) {
      result.push({ proposalId, chunks: model.chunks });
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

// ============================================================================
// HOOK
// ============================================================================

export function useInlineReview({
  editorRef,
  collabEnabled,
  operationsModels,
  applyChunkUpdate,
  sendProposalAccept,
  sendProposalReject,
  requestProposalUpdate,
}: UseInlineReviewOptions): UseInlineReviewResult {
  // Proposal IDs for the current review session — needed for finalization
  // (not tracked in CM6 state since it's proposal-level, not chunk-level)
  const activeProposalIdsRef = useRef<Set<string>>(new Set());

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

  const acceptChunkRef = useRef<(chunk: ReviewChunk) => void>(() => {});
  const rejectChunkRef = useRef<(chunk: ReviewChunk) => void>(() => {});

  // ------------------------------------------------------------------
  // Auto-finalization helper
  // ------------------------------------------------------------------

  /**
   * Check if all chunks are resolved. If so, send accept/reject per proposal
   * and clear review state. Called directly from accept/reject handlers —
   * reads CM6 state as source of truth.
   */
  const maybeAutoFinalize = useCallback(
    (view: EditorView) => {
      const state = getInlineReviewState(view.state);
      if (!state || state.chunks.length === 0) return;

      const allResolved = state.chunks.every((c) =>
        state.resolutions.has(c.id),
      );
      if (!allResolved) return;

      log.info("All chunks resolved, auto-finalizing", {
        total: state.chunks.length,
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
      for (const chunk of state.chunks) {
        const status = state.resolutions.get(chunk.id);
        if (!status) continue;
        const cur = perProposal.get(chunk.proposalId) ?? {
          accepted: 0,
          rejected: 0,
        };
        if (status === "accepted") cur.accepted++;
        else cur.rejected++;
        perProposal.set(chunk.proposalId, cur);
      }

      // For each proposal: if any accepted -> accept, else reject
      for (const [proposalId, counts] of perProposal) {
        if (counts.accepted > 0) {
          const key = crypto.randomUUID();
          sendProposalAccept(proposalId, key);
          log.info("Auto-accepted proposal", {
            proposalId,
            acceptedChunks: counts.accepted,
            rejectedChunks: counts.rejected,
          });
        } else {
          sendProposalReject(proposalId);
          log.info("Auto-rejected proposal", { proposalId });
        }
      }

      // Clear review state
      clearReviewEffect(view);
      activeProposalIdsRef.current = new Set();
      bump();
    },
    [sendProposalAccept, sendProposalReject, bump],
  );

  // ------------------------------------------------------------------
  // Accept/reject chunk handlers
  // ------------------------------------------------------------------

  const handleAcceptChunk = useCallback(
    (chunk: ReviewChunk) => {
      const { ok } = applyChunkUpdate(chunk);
      if (!ok) {
        log.warn("Failed to apply chunk update", { chunkId: chunk.id });
        return;
      }
      const view = getView();
      if (!view) return;

      resolveChunkEffect(view, chunk.id, "accepted");
      bump();
      maybeAutoFinalize(view);
    },
    [applyChunkUpdate, getView, bump, maybeAutoFinalize],
  );

  const handleRejectChunk = useCallback(
    (chunk: ReviewChunk) => {
      const view = getView();
      if (!view) return;

      resolveChunkEffect(view, chunk.id, "rejected");
      bump();
      maybeAutoFinalize(view);
    },
    [getView, bump, maybeAutoFinalize],
  );

  // Keep refs in sync with latest callback versions
  acceptChunkRef.current = handleAcceptChunk;
  rejectChunkRef.current = handleRejectChunk;

  // ------------------------------------------------------------------
  // Batch actions
  // ------------------------------------------------------------------

  const handleAcceptAll = useCallback(() => {
    const view = getView();
    if (!view) return;

    const state = getInlineReviewState(view.state);
    if (!state) return;

    const pending = state.chunks.filter((c) => !state.resolutions.has(c.id));
    for (const chunk of pending) {
      const { ok } = applyChunkUpdate(chunk);
      if (ok) {
        resolveChunkEffect(view, chunk.id, "accepted");
      }
    }

    // Send accept for each active proposal
    for (const proposalId of activeProposalIdsRef.current) {
      const key = crypto.randomUUID();
      sendProposalAccept(proposalId, key);
    }

    // Clear review state
    clearReviewEffect(view);
    activeProposalIdsRef.current = new Set();
    bump();
  }, [applyChunkUpdate, getView, sendProposalAccept, bump]);

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

  const handlePrevChunk = useCallback(() => {
    const view = getView();
    if (!view) return;

    const state = getInlineReviewState(view.state);
    if (!state || state.chunks.length === 0) return;

    const len = state.chunks.length;
    for (let step = 1; step <= len; step++) {
      const idx = (((state.activeChunkIndex - step) % len) + len) % len;
      if (!state.resolutions.has(state.chunks[idx]!.id)) {
        setActiveChunkIndex(view, idx);
        scrollToPos(view, state.chunks[idx]!.baseStart);
        bump();
        return;
      }
    }
  }, [getView, bump]);

  const handleNextChunk = useCallback(() => {
    const view = getView();
    if (!view) return;

    const state = getInlineReviewState(view.state);
    if (!state || state.chunks.length === 0) return;

    const len = state.chunks.length;
    for (let step = 1; step <= len; step++) {
      const idx = (state.activeChunkIndex + step) % len;
      if (!state.resolutions.has(state.chunks[idx]!.id)) {
        setActiveChunkIndex(view, idx);
        scrollToPos(view, state.chunks[idx]!.baseStart);
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
      onAcceptChunk: (chunk) => acceptChunkRef.current(chunk),
      onRejectChunk: (chunk) => rejectChunkRef.current(chunk),
    });
    // Only depends on collabEnabled — callbacks go through stable refs
  }, [collabEnabled]);

  // ------------------------------------------------------------------
  // Sync operationsModels → CM6 state (dispatch setReviewChunks)
  // ------------------------------------------------------------------

  useEffect(() => {
    if (!collabEnabled) {
      log.debug("Sync effect skipped: collabEnabled=false");
      return;
    }

    const view = getView();
    if (!view) {
      log.debug("Sync effect skipped: view not ready");
      return;
    }

    // Check that the inlineReviewField is present in the editor state
    const currentState = getInlineReviewState(view.state);
    if (!currentState) {
      log.warn("Sync effect: inlineReviewField NOT found in editor state — extension not registered");
      return;
    }

    const readyGroups = collectReadyChunks(operationsModels);
    const allChunks = readyGroups.flatMap((g) => g.chunks);
    const proposalIds = new Set(readyGroups.map((g) => g.proposalId));

    log.debug("Sync effect running", {
      operationsModelsSize: operationsModels.size,
      readyGroupCount: readyGroups.length,
      totalChunks: allChunks.length,
      availabilities: [...operationsModels.values()].map((m) =>
        m.availability === "unavailable"
          ? `unavailable:${m.reason} (${m.message})`
          : m.availability,
      ),
    });

    activeProposalIdsRef.current = proposalIds;

    if (allChunks.length > 0) {
      setReviewChunksEffect(view, allChunks);
      log.info("Loaded review chunks into editor", {
        count: allChunks.length,
        proposals: readyGroups.map((g) => g.proposalId),
      });
    } else {
      clearReviewEffect(view);
      log.debug("No ready chunks — cleared review state");
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
        requestedUpdatesRef.current.add(proposalId);
        requestProposalUpdate(proposalId);
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

    // Already loaded via the sync effect above — just scroll to first chunk
    if (model.chunks.length > 0) {
      scrollToPos(view, model.chunks[0]!.baseStart);
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
      totalChunks: state?.chunks.length ?? 0,
      activeChunkIndex: state?.activeChunkIndex ?? -1,
      resolvedCount: state?.resolutions.size ?? 0,
      onAcceptAll: handleAcceptAll,
      onRejectAll: handleRejectAll,
      onPrevChunk: handlePrevChunk,
      onNextChunk: handleNextChunk,
    };
    // version is a render trigger — its value is unused, but its change forces
    // re-computation so toolbar reads fresh CM6 state after each mutation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, getView, handleAcceptAll, handleRejectAll, handlePrevChunk, handleNextChunk]);

  return { extensions, toolbarProps };
}
