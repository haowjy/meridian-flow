/**
 * Lifecycle Event Handlers
 *
 * Handles AG-UI lifecycle events (RUN_*, STEP_*) and Meridian-specific events (TURN_*).
 *
 * AG-UI events:
 * - RUN_STARTED: Beginning of a run (one run may contain multiple steps)
 * - STEP_STARTED: Beginning of a step (tool loop iteration)
 * - STEP_FINISHED: End of a step
 * - RUN_FINISHED: Run completed successfully
 * - RUN_ERROR: Run terminated with error
 *
 * Meridian events (do the heavy lifting):
 * - TURN_COMPLETE: Refresh turn, cleanup streaming state
 * - TURN_ERROR: Handle errors, cleanup streaming state
 */

import { useEditorStore } from '@/core/stores/useEditorStore'
import type { SSEDispatchContext, SSEStoreActions } from '../types'
import type {
  TurnCompleteEvent,
  TurnErrorEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
} from '../../sseEventTypes'

/**
 * Handle TURN_COMPLETE event.
 * Refreshes turn, refreshes active document, and cleans up streaming state.
 */
export function handleTurnComplete(
  data: TurnCompleteEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions
): void {
  const { tracker, logger, buffer, ctrl, threadId } = ctx
  const turnId = data.turn_id

  logger.debug('sse:turn_complete', data)

  // Notify waiters that stream has ended (for cancel coordination)
  actions.notifyStreamEnded(turnId)

  // Helper to run cleanup - must run AFTER refreshTurn completes
  // to ensure tool_result blocks are fetched before clearing streaming state
  const runCleanup = () => {
    buffer.flush()
    logger.debug('sse:turn_complete:cleanup', { turnId })
    actions.clearStreamingStream()
    tracker.clear()
    actions.setStreamingBlockInfo(null, null)
    // Stop the stream
    ctrl.abort()
  }

  // Chain refreshTurn -> document refresh -> cleanup
  // Cleanup runs in .finally() to ensure it always executes, even on error
  if (threadId && turnId) {
    actions
      .refreshTurn(threadId, turnId)
      .then(() => {
        // Refresh active document in case AI edited it via doc_edit tool
        // This ensures ai_version changes are reflected in the editor
        // Fire-and-forget - document refresh shouldn't block cleanup
        const activeDocId = useEditorStore.getState()._activeDocumentId
        if (activeDocId) {
          useEditorStore
            .getState()
            .refreshDocument(activeDocId)
            .catch((err) =>
              logger.error('sse:turn_complete:document_refresh_error', err)
            )
        }
      })
      .catch((err) => logger.error('sse:turn_complete:refresh_error', err))
      .finally(runCleanup)
  } else {
    // No turn to refresh - cleanup immediately
    runCleanup()
  }
}

/**
 * Handle TURN_ERROR event.
 * Refreshes turn to get final state (partial blocks + error field) and cleans up.
 */
export function handleTurnError(
  data: TurnErrorEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions
): void {
  const { tracker, logger, buffer, ctrl, threadId } = ctx

  // Log error (non-cancellation) or debug (cancellation)
  if (!data.is_cancelled) {
    logger.error('sse:turn_error', data)
  } else {
    logger.debug('sse:turn_cancelled', data)
  }

  // Notify waiters that stream has ended (for cancel coordination)
  actions.notifyStreamEnded(data.turn_id)

  // Refresh the turn to ensure we have the final state (partial blocks + error field)
  // The inline error will be displayed via Turn.error in AssistantTurn component
  if (threadId && data.turn_id) {
    actions.refreshTurn(threadId, data.turn_id).catch((err) =>
      logger.error('sse:turn_error:refresh_error', err)
    )
  }

  // Cleanup
  buffer.flush()
  actions.clearStreamingStream()
  tracker.clear()
  actions.setStreamingBlockInfo(null, null)
  // Stop the stream
  ctrl.abort()
}

// ============================================================================
// AG-UI Lifecycle Handlers
//
// These events are part of the AG-UI SDK protocol. The heavy lifting (cleanup,
// refresh) is done by turn_complete/turn_error. These handlers provide:
// - Logging for debugging/observability
// - Future extensibility (e.g., step progress UI)
// ============================================================================

/**
 * Handle RUN_STARTED event.
 * Signals the beginning of a streaming run. One run may contain multiple steps
 * (tool loop iterations).
 *
 * Note: Cleanup is done in turn_complete/turn_error, not here, because a new
 * run for the same turn would have already triggered those events.
 */
export function handleRunStarted(
  data: RunStartedEvent,
  ctx: SSEDispatchContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Matches SSEEventHandler signature for consistency
  _actions: SSEStoreActions
): void {
  const { logger } = ctx
  logger.debug('sse:run_started', { runId: data.runId, threadId: data.threadId })
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
  _actions: SSEStoreActions
): void {
  const { logger } = ctx
  logger.debug('sse:step_started', { stepName: data.stepName })
}

/**
 * Handle STEP_FINISHED event.
 * Signals the end of a step (tool loop iteration).
 */
export function handleStepFinished(
  data: StepFinishedEvent,
  ctx: SSEDispatchContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Matches SSEEventHandler signature for consistency
  _actions: SSEStoreActions
): void {
  const { logger } = ctx
  logger.debug('sse:step_finished', { stepName: data.stepName })
}

/**
 * Handle RUN_FINISHED event.
 * Signals successful completion of the run.
 *
 * Note: The actual cleanup is done by turn_complete which fires after this.
 * This handler exists for AG-UI protocol completeness and future extensibility.
 */
export function handleRunFinished(
  data: RunFinishedEvent,
  ctx: SSEDispatchContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Matches SSEEventHandler signature for consistency
  _actions: SSEStoreActions
): void {
  const { logger } = ctx
  logger.debug('sse:run_finished', { runId: data.runId })
}

/**
 * Handle RUN_ERROR event.
 * Signals the run terminated with an error.
 *
 * Note: The actual error handling and cleanup is done by turn_error which
 * fires after this. This handler exists for AG-UI protocol completeness.
 */
export function handleRunError(
  data: RunErrorEvent,
  ctx: SSEDispatchContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Matches SSEEventHandler signature for consistency
  _actions: SSEStoreActions
): void {
  const { logger } = ctx
  // Log as debug, not error - turn_error handles the actual error logging
  // Note: AG-UI spec uses 'message' field (not 'error') for error description
  logger.debug('sse:run_error', { runId: data.runId, message: data.message })
}
