/**
 * Lifecycle Event Handlers
 *
 * Handles AG-UI lifecycle events (RUN_*, STEP_*) with Meridian extensions.
 *
 * AG-UI events (with Meridian extensions):
 * - RUN_STARTED: Beginning of a run + turnId + lastBlockSequence for reconnection
 * - STEP_STARTED: Beginning of a step (tool loop iteration)
 * - STEP_FINISHED: End of a step
 * - RUN_FINISHED: Run completed + turnId + stopReason, inputTokens, outputTokens
 * - RUN_ERROR: Error/cancel + turnId + isCancelled flag
 */

import { useEditorStore } from "@/core/stores/useEditorStore";
import type { SSEDispatchContext, SSEStoreActions } from "../types";
import type {
  MeridianRunStartedEvent,
  MeridianRunFinishedEvent,
  MeridianRunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
} from "../../sseEventTypes";

// ============================================================================
// AG-UI Lifecycle Handlers
// ============================================================================

/**
 * Handle RUN_STARTED event.
 * Signals the beginning of a streaming run. One run may contain multiple steps
 * (tool loop iterations).
 *
 * On reconnection, lastBlockSequence tells the frontend where to start indexing
 * new blocks to avoid duplicates.
 */
export function handleRunStarted(
  data: MeridianRunStartedEvent,
  ctx: SSEDispatchContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Matches SSEEventHandler signature for consistency
  _actions: SSEStoreActions,
): void {
  const { logger, tracker } = ctx;

  // Initialize BlockTracker from lastBlockSequence on reconnection
  // This ensures new blocks start from lastBlockSequence + 1, avoiding duplicates
  if (data.lastBlockSequence !== undefined && data.lastBlockSequence >= 0) {
    tracker.initializeFromSequence(data.lastBlockSequence);
    logger.debug("sse:run_started:reconnection", {
      runId: data.runId,
      threadId: data.threadId,
      lastBlockSequence: data.lastBlockSequence,
    });
  } else {
    logger.debug("sse:run_started", {
      runId: data.runId,
      threadId: data.threadId,
    });
  }
}

/**
 * Handle STEP_STARTED event.
 * Signals the beginning of a step (tool loop iteration).
 * Can be used for UI showing "Step N of M" or progress indicators.
 */
export function handleStepStarted(
  data: StepStartedEvent,
  ctx: SSEDispatchContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Matches SSEEventHandler signature for consistency
  _actions: SSEStoreActions,
): void {
  const { logger } = ctx;
  logger.debug("sse:step_started", { stepName: data.stepName });
}

/**
 * Handle STEP_FINISHED event.
 * Signals the end of a step (tool loop iteration).
 */
export function handleStepFinished(
  data: StepFinishedEvent,
  ctx: SSEDispatchContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Matches SSEEventHandler signature for consistency
  _actions: SSEStoreActions,
): void {
  const { logger } = ctx;
  logger.debug("sse:step_finished", { stepName: data.stepName });
}

/**
 * Handle RUN_FINISHED event.
 * Signals successful completion of the run.
 * Refreshes turn, refreshes active document, and cleans up streaming state.
 *
 * Meridian extension: includes turnId, stopReason, inputTokens, outputTokens.
 */
export function handleRunFinished(
  data: MeridianRunFinishedEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions,
): void {
  const { tracker, logger, buffer, ctrl, threadId } = ctx;
  // Use turnId directly from Meridian extension (avoids parsing runId)
  // ?? preserves empty string as valid (convention: treat empty as valid)
  const turnId = data.turnId ?? null;

  logger.debug("sse:run_finished", {
    turnId,
    stopReason: data.stopReason,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
  });

  // Notify waiters that stream has ended (for cancel coordination)
  if (turnId) {
    actions.notifyStreamEnded(turnId);
  }

  // Helper to run cleanup - must run AFTER refreshTurn completes
  // to ensure tool_result blocks are fetched before clearing streaming state
  const runCleanup = () => {
    buffer.flush();
    logger.debug("sse:run_finished:cleanup", { turnId });
    actions.clearStreamingStream();
    tracker.clear();
    actions.setStreamingBlockInfo(null, null);
    // Stop the stream
    ctrl.abort();
  };

  // Chain refreshTurn -> document refresh -> cleanup
  // Cleanup runs in .finally() to ensure it always executes, even on error
  if (threadId && turnId) {
    actions
      .refreshTurn(threadId, turnId)
      .then(() => {
        // Refresh active document in case AI edited it via text editor tool
        // Fire-and-forget - document refresh shouldn't block cleanup
        const activeDocId = useEditorStore.getState()._activeDocumentId;
        if (activeDocId) {
          useEditorStore
            .getState()
            .refreshDocument(activeDocId)
            .catch((err) =>
              logger.error("sse:run_finished:document_refresh_error", err),
            );
        }
      })
      .catch((err) => logger.error("sse:run_finished:refresh_error", err))
      .finally(runCleanup);
  } else {
    // No turn to refresh - cleanup immediately
    runCleanup();
  }
}

/**
 * Handle RUN_ERROR event.
 * Signals the run terminated with an error or cancellation.
 * Refreshes turn to get final state (partial blocks + error field) and cleans up.
 *
 * Meridian extension: turnId + isCancelled distinguishes user cancel from actual error.
 */
export function handleRunError(
  data: MeridianRunErrorEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions,
): void {
  const { tracker, logger, buffer, ctrl, threadId } = ctx;
  // Use turnId directly from Meridian extension (avoids parsing runId)
  // ?? preserves empty string as valid (convention: treat empty as valid)
  const turnId = data.turnId ?? null;

  // Log error (non-cancellation) or debug (cancellation)
  if (!data.isCancelled) {
    logger.error("sse:run_error", { turnId, message: data.message });
  } else {
    logger.debug("sse:run_cancelled", { turnId, message: data.message });
  }

  // Notify waiters that stream has ended (for cancel coordination)
  if (turnId) {
    actions.notifyStreamEnded(turnId);
  }

  // Refresh the turn to ensure we have the final state (partial blocks + error field)
  // The inline error will be displayed via Turn.error in AssistantTurn component
  if (threadId && turnId) {
    actions
      .refreshTurn(threadId, turnId)
      .catch((err) => logger.error("sse:run_error:refresh_error", err));
  }

  // Cleanup
  buffer.flush();
  actions.clearStreamingStream();
  tracker.clear();
  actions.setStreamingBlockInfo(null, null);
  // Stop the stream
  ctrl.abort();
}
