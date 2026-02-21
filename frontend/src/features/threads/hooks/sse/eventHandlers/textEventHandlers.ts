/**
 * Text Event Handlers
 *
 * Handles TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END events.
 * These events stream text content from the LLM.
 */

import type { SSEDispatchContext, SSEStoreActions } from "../types";
import type {
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
} from "../../sseEventTypes";

/**
 * Handle TEXT_MESSAGE_START event.
 * Registers a new text block and prepares for content streaming.
 */
export function handleTextMessageStart(
  data: TextMessageStartEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions,
): void {
  const { tracker } = ctx;

  // Get next block index and register the message
  const blockIndex = tracker.nextBlockIndex();
  tracker.setCurrentBlockType("text");
  tracker.registerMessage(data.messageId, blockIndex);

  actions.setStreamingBlockInfo(blockIndex, "text");
}

/**
 * Handle TEXT_MESSAGE_CONTENT event.
 * Appends text delta to the streaming buffer.
 */
export function handleTextMessageContent(
  data: TextMessageContentEvent,
  ctx: SSEDispatchContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _actions: SSEStoreActions,
): void {
  if (!data.delta) return;

  const blockIndex = ctx.tracker.getMessageBlockIndex(data.messageId);
  if (blockIndex === undefined) {
    ctx.logger.warn("sse:TEXT_MESSAGE_CONTENT:no_block", {
      messageId: data.messageId,
    });
    return;
  }

  ctx.buffer.append(blockIndex, "text", data.delta);
}

/**
 * Handle TEXT_MESSAGE_END event.
 * Flushes buffer and cleans up message tracking.
 */
export function handleTextMessageEnd(
  data: TextMessageEndEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions,
): void {
  const { tracker, buffer } = ctx;

  buffer.flush();

  const endBlockIndex = tracker.getMessageBlockIndex(data.messageId);
  const shouldClearCurrent =
    tracker.getCurrentBlockType() === "text" &&
    endBlockIndex !== undefined &&
    endBlockIndex === tracker.getCurrentBlockIndex();

  tracker.removeMessage(data.messageId);
  if (shouldClearCurrent) {
    tracker.setCurrentBlockType(null);
    actions.setStreamingBlockInfo(null, null);
  }
}
