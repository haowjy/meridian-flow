/**
 * Stream-event classification shared by the retry gate and observability.
 *
 * Two questions look similar but must stay separate:
 * - Did the attempt emit anything at all? (`isPartialOutputEvent`) — drives
 *   cancel draining and first-output timing.
 * - Did it emit output the caller may have already acted on?
 *   (`isCommittedOutputEvent`) — drives the retry gate.
 *
 * Reasoning deltas and usage are process output, not committed output: a
 * provider that reasons and then stalls before answering is retryable, while
 * one that has already streamed visible text or opened a tool call is not.
 */
import type { StreamEvent } from "./domain/index.js";

/**
 * Any event that carries provider content, including reasoning, usage, and
 * custom events. Start and error are control events, not output.
 */
export function isPartialOutputEvent(event: StreamEvent): boolean {
  return event.type !== "start" && event.type !== "error";
}

/**
 * Output the caller may have acted on: visible text, a tool call, a custom
 * content delta, or a terminal success. Reasoning and usage are excluded so an
 * attempt aborted while still thinking remains retryable.
 */
export function isCommittedOutputEvent(event: StreamEvent): boolean {
  switch (event.type) {
    case "text.delta":
    case "tool_call.delta":
    case "custom.delta":
    case "end":
      return true;
    default:
      return false;
  }
}
