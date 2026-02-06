/**
 * Interjection Event Handlers
 *
 * Handlers for Meridian's interjection feature which allows users to submit
 * messages while an assistant turn is actively streaming.
 */

import { turnDtoToTurn } from "@/core/lib/api";
import type { SSEDispatchContext, SSEStoreActions } from "../types";
import type {
  InterjectionUpdatedEvent,
  StreamSwitchEvent,
} from "../../sseEventTypes";

/**
 * Handle INTERJECTION_UPDATED event.
 * Updates the interjection content display in the UI.
 */
export function handleInterjectionUpdated(
  data: InterjectionUpdatedEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions,
): void {
  ctx.logger.debug("sse:interjection_updated", {
    turnId: data.turnId,
    length: data.length,
  });

  actions.setInterjectionContent(data.content);
}

/**
 * Handle STREAM_SWITCH event.
 * Triggered when an interjection is injected and a new stream starts.
 * Frontend should merge the new turns and reconnect to the new stream.
 */
export function handleStreamSwitch(
  data: StreamSwitchEvent,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions,
): void {
  ctx.logger.info("sse:stream_switch", {
    prevTurnId: data.prevAssistantTurnId,
    reason: data.reason,
    newStreamUrl: data.streamUrl,
  });

  // Convert TurnDto → Turn (dates become Date objects)
  // SSE parser already converted snake_case → camelCase, but dates are still strings
  const userTurn = turnDtoToTurn(data.userTurn);
  const assistantTurn = turnDtoToTurn(data.assistantTurn);

  // Apply the stream switch - this merges turns and updates streaming state
  actions.applyStreamSwitch(
    data.prevAssistantTurnId,
    userTurn,
    assistantTurn,
    data.streamUrl,
  );

  // Clear interjection content (it's now persisted as a user turn)
  actions.setInterjectionContent(null);

  // Abort the current SSE connection to trigger reconnect with new stream
  // The useThreadSSE hook will detect the new streamingUrl and connect
  ctx.ctrl.abort();

  ctx.logger.info("sse:stream_switch_complete", {
    aborted: true,
    newStreamUrl: data.streamUrl,
  });
}
