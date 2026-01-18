/**
 * SSE Event Dispatcher
 *
 * Routes incoming SSE events to their appropriate handlers.
 * This module follows the Single Responsibility Principle (SRP) by only
 * handling event routing, not the actual event processing logic.
 */

import { SSE_EVENTS } from '../sseEventTypes'
import type { SSEDispatchContext, SSEStoreActions } from './types'
import {
  // Tool handlers
  handleToolCallStart,
  handleToolCallArgs,
  handleToolCallEnd,
  handleToolCallResult,
  // Text handlers
  handleTextMessageStart,
  handleTextMessageContent,
  handleTextMessageEnd,
  // Thinking handlers
  handleThinkingStart,
  handleThinkingTextMessageStart,
  handleThinkingTextMessageContent,
  handleThinkingTextMessageEnd,
  handleThinkingEnd,
  // Meridian lifecycle handlers
  handleTurnComplete,
  handleTurnError,
  // AG-UI lifecycle handlers
  handleRunStarted,
  handleRunFinished,
  handleRunError,
  handleStepStarted,
  handleStepFinished,
} from './eventHandlers'

/**
 * Dispatch an SSE event to the appropriate handler.
 *
 * @param eventType - The SSE event type string
 * @param data - The raw data string from the event
 * @param ctx - Dispatch context with dependencies
 * @param actions - Store actions available to handlers
 */
export function dispatchSSEEvent(
  eventType: string,
  data: string,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions
): void {
  const { logger } = ctx

  try {
    switch (eventType) {
      // ============================================================
      // AG-UI Tool Call Events
      // Native AG-UI protocol for streaming tool calls
      // ============================================================

      case SSE_EVENTS.TOOL_CALL_START: {
        const parsed = JSON.parse(data)
        handleToolCallStart(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.TOOL_CALL_ARGS: {
        const parsed = JSON.parse(data)
        handleToolCallArgs(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.TOOL_CALL_END: {
        const parsed = JSON.parse(data)
        handleToolCallEnd(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.TOOL_CALL_RESULT: {
        const parsed = JSON.parse(data)
        handleToolCallResult(parsed, ctx, actions)
        break
      }

      // ============================================================
      // AG-UI Text Message Events
      // ============================================================

      case SSE_EVENTS.TEXT_MESSAGE_START: {
        const parsed = JSON.parse(data)
        handleTextMessageStart(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.TEXT_MESSAGE_CONTENT: {
        const parsed = JSON.parse(data)
        handleTextMessageContent(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.TEXT_MESSAGE_END: {
        const parsed = JSON.parse(data)
        handleTextMessageEnd(parsed, ctx, actions)
        break
      }

      // ============================================================
      // AG-UI Thinking Events
      // Nested structure: THINKING_START → TEXT_MESSAGE_* → THINKING_END
      // ============================================================

      case SSE_EVENTS.THINKING_START: {
        const parsed = JSON.parse(data)
        handleThinkingStart(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.THINKING_TEXT_MESSAGE_START: {
        handleThinkingTextMessageStart(undefined, ctx, actions)
        break
      }

      case SSE_EVENTS.THINKING_TEXT_MESSAGE_CONTENT: {
        const parsed = JSON.parse(data)
        handleThinkingTextMessageContent(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.THINKING_TEXT_MESSAGE_END: {
        handleThinkingTextMessageEnd(undefined, ctx, actions)
        break
      }

      case SSE_EVENTS.THINKING_END: {
        const parsed = JSON.parse(data)
        handleThinkingEnd(parsed, ctx, actions)
        break
      }

      // ============================================================
      // Meridian-specific Turn Lifecycle Events
      // ============================================================

      case SSE_EVENTS.TURN_COMPLETE: {
        const parsed = JSON.parse(data)
        handleTurnComplete(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.TURN_ERROR: {
        logger.debug('sse:turn_error:raw', { data })
        const parsed = JSON.parse(data)
        handleTurnError(parsed, ctx, actions)
        break
      }

      // ============================================================
      // AG-UI Lifecycle Events
      // Run and step management for tool loops
      // ============================================================

      case SSE_EVENTS.RUN_STARTED: {
        const parsed = JSON.parse(data)
        handleRunStarted(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.RUN_FINISHED: {
        const parsed = JSON.parse(data)
        handleRunFinished(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.RUN_ERROR: {
        const parsed = JSON.parse(data)
        handleRunError(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.STEP_STARTED: {
        const parsed = JSON.parse(data)
        handleStepStarted(parsed, ctx, actions)
        break
      }

      case SSE_EVENTS.STEP_FINISHED: {
        const parsed = JSON.parse(data)
        handleStepFinished(parsed, ctx, actions)
        break
      }

      default:
        // Unknown event type - log for debugging
        logger.debug('sse:unknown_event', { eventType, data })
    }
  } catch (error) {
    // AG-UI: Log raw data (truncated) for debugging malformed events
    logger.error(`sse:${eventType}:parse_error`, {
      error,
      rawData: data.slice(0, 500), // Truncate to avoid log spam
    })
  }
}
