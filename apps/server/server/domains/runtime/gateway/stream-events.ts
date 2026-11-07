/**
 * Stream-event classification shared by the retry gate and per-attempt timing.
 *
 * Two questions look similar but must stay separate:
 * - Did it emit the first model output token? (`isFirstTokenEvent`) — drives
 *   provider-arrival TTFT and generation-duration timing.
 * - Did it emit output the caller may have already acted on?
 *   (`isCommittedOutputEvent`) — drives the retry gate.
 *
 * Reasoning deltas and usage are process output, not committed output: a
 * provider that reasons and then stalls before answering is retryable, while
 * one that has already streamed visible text or opened a tool call is not.
 */
import type { StreamEvent } from "./domain/index.js";

/** Content deltas the writer can receive. */
export function isFirstTokenEvent(event: StreamEvent): boolean {
  switch (event.type) {
    case "text.delta":
    case "reasoning.delta":
      return event.text.length > 0;
    case "tool_call.delta":
      return event.argumentsDelta.length > 0;
    default:
      return false;
  }
}

/**
 * Output the caller may have acted on: visible text, a tool call, or a terminal success. Reasoning and usage are excluded so an
 * attempt aborted while still thinking remains retryable.
 */
export function isCommittedOutputEvent(event: StreamEvent): boolean {
  switch (event.type) {
    case "text.delta":
    case "tool_call.delta":
    case "end":
      return true;
    default:
      return false;
  }
}
