/**
 * SSE Event Dispatcher
 *
 * Routes incoming SSE events to their appropriate handlers.
 * This module follows the Single Responsibility Principle (SRP) by only
 * handling event routing, not the actual event processing logic.
 *
 * All events are AG-UI protocol compliant with Meridian extensions.
 */

import { SSE_EVENTS } from "../sseEventTypes";
import type { SSEDispatchContext, SSEStoreActions } from "./types";
import { parseSSEEvent } from "./sseEventParser";
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
  // AG-UI lifecycle handlers (with Meridian extensions)
  handleRunStarted,
  handleRunFinished,
  handleRunError,
  handleStepStarted,
  handleStepFinished,
  // Interjection handlers
  handleInterjectionUpdated,
  handleStreamSwitch,
} from "./eventHandlers";

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
  actions: SSEStoreActions,
): void {
  const { logger } = ctx;

  // Helper to parse JSON (with camelCase conversion) and invoke handler with separate error tracking
  const parseAndHandle = <T>(
    handler: (
      data: T,
      ctx: SSEDispatchContext,
      actions: SSEStoreActions,
    ) => void,
  ) => {
    let parsed: T;
    try {
      // Use SSE gateway parser for consistent snake_case → camelCase conversion
      parsed = parseSSEEvent<T>(data);
    } catch (parseError) {
      logger.error(`sse:${eventType}:parse_error`, {
        error: parseError,
        rawData: data.slice(0, 500), // Truncate to avoid log spam
      });
      return;
    }
    try {
      handler(parsed, ctx, actions);
    } catch (handlerError) {
      logger.error(`sse:${eventType}:handler_error`, {
        error: handlerError,
        parsed,
      });
    }
  };

  switch (eventType) {
    // ============================================================
    // AG-UI Tool Call Events
    // Native AG-UI protocol for streaming tool calls
    // ============================================================

    case SSE_EVENTS.TOOL_CALL_START:
      parseAndHandle(handleToolCallStart);
      break;

    case SSE_EVENTS.TOOL_CALL_ARGS:
      parseAndHandle(handleToolCallArgs);
      break;

    case SSE_EVENTS.TOOL_CALL_END:
      parseAndHandle(handleToolCallEnd);
      break;

    case SSE_EVENTS.TOOL_CALL_RESULT:
      parseAndHandle(handleToolCallResult);
      break;

    // ============================================================
    // AG-UI Text Message Events
    // ============================================================

    case SSE_EVENTS.TEXT_MESSAGE_START:
      parseAndHandle(handleTextMessageStart);
      break;

    case SSE_EVENTS.TEXT_MESSAGE_CONTENT:
      parseAndHandle(handleTextMessageContent);
      break;

    case SSE_EVENTS.TEXT_MESSAGE_END:
      parseAndHandle(handleTextMessageEnd);
      break;

    // ============================================================
    // AG-UI Thinking Events
    // Nested structure: THINKING_START → TEXT_MESSAGE_* → THINKING_END
    // ============================================================

    case SSE_EVENTS.THINKING_START:
      parseAndHandle(handleThinkingStart);
      break;

    case SSE_EVENTS.THINKING_TEXT_MESSAGE_START:
      // No data to parse for this event
      try {
        handleThinkingTextMessageStart(undefined, ctx, actions);
      } catch (handlerError) {
        logger.error(`sse:${eventType}:handler_error`, { error: handlerError });
      }
      break;

    case SSE_EVENTS.THINKING_TEXT_MESSAGE_CONTENT:
      parseAndHandle(handleThinkingTextMessageContent);
      break;

    case SSE_EVENTS.THINKING_TEXT_MESSAGE_END:
      // No data to parse for this event
      try {
        handleThinkingTextMessageEnd(undefined, ctx, actions);
      } catch (handlerError) {
        logger.error(`sse:${eventType}:handler_error`, { error: handlerError });
      }
      break;

    case SSE_EVENTS.THINKING_END:
      parseAndHandle(handleThinkingEnd);
      break;

    // ============================================================
    // AG-UI Lifecycle Events (with Meridian extensions)
    // These are the primary lifecycle events for run/step management
    // ============================================================

    case SSE_EVENTS.RUN_STARTED:
      parseAndHandle(handleRunStarted);
      break;

    case SSE_EVENTS.RUN_FINISHED:
      parseAndHandle(handleRunFinished);
      break;

    case SSE_EVENTS.RUN_ERROR:
      parseAndHandle(handleRunError);
      break;

    case SSE_EVENTS.STEP_STARTED:
      parseAndHandle(handleStepStarted);
      break;

    case SSE_EVENTS.STEP_FINISHED:
      parseAndHandle(handleStepFinished);
      break;

    // ============================================================
    // Meridian Interjection Events
    // ============================================================

    case SSE_EVENTS.INTERJECTION_UPDATED:
      parseAndHandle(handleInterjectionUpdated);
      break;

    case SSE_EVENTS.STREAM_SWITCH:
      parseAndHandle(handleStreamSwitch);
      break;

    default:
      // Unknown event type - log for debugging
      logger.debug("sse:unknown_event", { eventType, data });
  }
}
