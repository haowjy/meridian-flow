/**
 * Simplified AG-UI event types for the activity stream reducer.
 *
 * These mirror the real AG-UI protocol events (from @ag-ui/core) but are
 * self-contained — no external dependency needed until we integrate the
 * real SSE layer.
 */

export type StreamEvent =
  | { type: "RUN_STARTED" }
  | { type: "RUN_FINISHED" }
  | { type: "TEXT_MESSAGE_START"; messageId: string }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "THINKING_START"; thinkingId: string }
  | { type: "THINKING_TEXT_CONTENT"; thinkingId: string; delta: string }
  | { type: "THINKING_END"; thinkingId: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | { type: "TOOL_CALL_RESULT"; toolCallId: string; resultText: string; isError?: boolean }
  | { type: "RESET" }

/** All valid StreamEvent type discriminators. Single source of truth for validation. */
export const STREAM_EVENT_TYPES: readonly StreamEvent["type"][] = [
  "RUN_STARTED",
  "RUN_FINISHED",
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "THINKING_START",
  "THINKING_TEXT_CONTENT",
  "THINKING_END",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "TOOL_CALL_RESULT",
  "RESET",
] as const

export const STREAM_EVENT_TYPE_SET: ReadonlySet<string> = new Set(STREAM_EVENT_TYPES)
