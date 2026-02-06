/**
 * Thinking Event Handlers
 *
 * Handles THINKING_START, THINKING_TEXT_MESSAGE_*, THINKING_END events.
 * These events stream thinking/reasoning content from the LLM.
 *
 * Structure: THINKING_START → TEXT_MESSAGE_* → THINKING_END
 */

import type { SSEDispatchContext, SSEStoreActions } from "../types";
import type {
  ThinkingStartEvent,
  ThinkingTextMessageContentEvent,
  ThinkingEndEvent,
} from "../../sseEventTypes";

/**
 * Handle THINKING_START event.
 * Registers a new thinking block.
 */
export function handleThinkingStart(
  data: ThinkingStartEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions,
): void {
  const { tracker, logger } = ctx;

  // Get next block index and register the thinking block
  const blockIndex = tracker.nextBlockIndex();
  tracker.setCurrentBlockType("thinking");
  tracker.registerThinking(data.thinkingId, blockIndex);

  actions.setStreamingBlockInfo(blockIndex, "thinking");

  logger.debug("sse:THINKING_START", {
    thinkingId: data.thinkingId,
    blockIndex,
  });
}

/**
 * Handle THINKING_TEXT_MESSAGE_START event.
 * Signals start of thinking content (no-op, we wait for content).
 */
export function handleThinkingTextMessageStart(
  _data: unknown,
  ctx: SSEDispatchContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _actions: SSEStoreActions,
): void {
  ctx.logger.debug("sse:THINKING_TEXT_MESSAGE_START");
}

/**
 * Handle THINKING_TEXT_MESSAGE_CONTENT event.
 * Appends thinking text delta to the streaming buffer.
 */
export function handleThinkingTextMessageContent(
  data: ThinkingTextMessageContentEvent,
  ctx: SSEDispatchContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _actions: SSEStoreActions,
): void {
  if (!data.delta) return;

  // Some providers omit thinkingId on THINKING_TEXT_MESSAGE_CONTENT; fall back to the
  // currently active thinking block (tracked on THINKING_START).
  const blockIndex = data.thinkingId
    ? ctx.tracker.getThinkingBlockIndex(data.thinkingId)
    : (ctx.tracker.getActiveThinkingBlockIndex() ??
      ctx.tracker.getCurrentBlockIndex());

  if (blockIndex === undefined || blockIndex === null) {
    ctx.logger.warn("sse:THINKING_TEXT_MESSAGE_CONTENT:no_block");
    return;
  }

  ctx.buffer.append(blockIndex, "thinking", data.delta);
}

/**
 * Handle THINKING_TEXT_MESSAGE_END event.
 * Signals end of thinking content within this thinking block (no-op).
 */
export function handleThinkingTextMessageEnd(
  _data: unknown,
  ctx: SSEDispatchContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _actions: SSEStoreActions,
): void {
  ctx.logger.debug("sse:THINKING_TEXT_MESSAGE_END");
}

/**
 * Handle THINKING_END event.
 * Flushes buffer and cleans up thinking tracking.
 */
export function handleThinkingEnd(
  data: ThinkingEndEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions,
): void {
  const { tracker, logger, buffer } = ctx;

  buffer.flush();

  const endBlockIndex = tracker.getThinkingBlockIndex(data.thinkingId);
  const shouldClearCurrent =
    tracker.getCurrentBlockType() === "thinking" &&
    endBlockIndex !== undefined &&
    endBlockIndex === tracker.getCurrentBlockIndex();

  tracker.removeThinking(data.thinkingId);
  if (shouldClearCurrent) {
    tracker.setCurrentBlockType(null);
    actions.setStreamingBlockInfo(null, null);
  }

  logger.debug("sse:THINKING_END", {
    thinkingId: data.thinkingId,
    clearedCurrent: shouldClearCurrent,
  });
}
