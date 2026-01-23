/**
 * SSE Event Type Constants
 *
 * Uses official AG-UI types from @ag-ui/core for spec compliance.
 * Meridian extends AG-UI lifecycle events with additional fields:
 * - RUN_STARTED: adds lastBlockSequence for reconnection support
 * - RUN_FINISHED: adds stopReason, inputTokens, outputTokens
 * - RUN_ERROR: adds isCancelled to distinguish cancel from error
 *
 * Thinking events are also extended with thinkingId for tracking.
 */
import {
  EventType,
  type TextMessageStartEvent as AGUITextMessageStartEvent,
  type TextMessageContentEvent as AGUITextMessageContentEvent,
  type TextMessageEndEvent as AGUITextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type StepStartedEvent,
  type StepFinishedEvent,
  type ThinkingStartEvent as AGUIThinkingStartEvent,
  type ThinkingEndEvent as AGUIThinkingEndEvent,
  type ThinkingTextMessageStartEvent as AGUIThinkingTextMessageStartEvent,
  type ThinkingTextMessageContentEvent as AGUIThinkingTextMessageContentEvent,
  type ThinkingTextMessageEndEvent as AGUIThinkingTextMessageEndEvent,
} from '@ag-ui/core'

// Re-export official types
export type {
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  StepStartedEvent,
  StepFinishedEvent,
}

// ============================================================================
// Meridian-Extended AG-UI Lifecycle Events
//
// These extend the official AG-UI events with Meridian-specific fields.
// The base fields match AG-UI spec; extra fields are Meridian extensions.
// ============================================================================

/**
 * Extended RUN_STARTED event with reconnection support.
 * lastBlockSequence tells the frontend where to start indexing new blocks
 * to avoid duplicates on reconnection.
 * turnId is provided directly to avoid parsing runId.
 */
export interface MeridianRunStartedEvent extends RunStartedEvent {
  turnId?: string // Raw turn ID (avoids parsing "run_{turnId}")
  lastBlockSequence?: number // Omitted on first connection, present on reconnection
}

/**
 * Extended RUN_FINISHED event with LLM metadata.
 * Includes token counts and stop reason for display/tracking.
 * turnId is provided directly to avoid parsing runId.
 */
export interface MeridianRunFinishedEvent extends RunFinishedEvent {
  turnId?: string // Raw turn ID (avoids parsing "run_{turnId}")
  stopReason?: string
  inputTokens?: number
  outputTokens?: number
}

/**
 * Extended RUN_ERROR event with cancellation distinction.
 * isCancelled prevents error toast for user cancellations.
 * turnId is provided directly to avoid parsing runId.
 */
export interface MeridianRunErrorEvent extends RunErrorEvent {
  turnId?: string // Raw turn ID (avoids parsing "run_{turnId}")
  isCancelled?: boolean
}

// Re-export text message types (official types, no extensions needed)
export type TextMessageStartEvent = AGUITextMessageStartEvent
export type TextMessageContentEvent = AGUITextMessageContentEvent
export type TextMessageEndEvent = AGUITextMessageEndEvent

// ============================================================================
// SSE Event Constants
// Use official EventType enum for all AG-UI events
// ============================================================================

export const SSE_EVENTS = {
  // AG-UI Tool Events
  TOOL_CALL_START: EventType.TOOL_CALL_START,
  TOOL_CALL_ARGS: EventType.TOOL_CALL_ARGS,
  TOOL_CALL_END: EventType.TOOL_CALL_END,
  TOOL_CALL_RESULT: EventType.TOOL_CALL_RESULT,

  // AG-UI Text Events
  TEXT_MESSAGE_START: EventType.TEXT_MESSAGE_START,
  TEXT_MESSAGE_CONTENT: EventType.TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_END: EventType.TEXT_MESSAGE_END,

  // AG-UI Thinking Events
  THINKING_START: EventType.THINKING_START,
  THINKING_TEXT_MESSAGE_START: EventType.THINKING_TEXT_MESSAGE_START,
  THINKING_TEXT_MESSAGE_CONTENT: EventType.THINKING_TEXT_MESSAGE_CONTENT,
  THINKING_TEXT_MESSAGE_END: EventType.THINKING_TEXT_MESSAGE_END,
  THINKING_END: EventType.THINKING_END,

  // AG-UI Lifecycle Events (now the primary events)
  RUN_STARTED: EventType.RUN_STARTED,
  RUN_FINISHED: EventType.RUN_FINISHED,
  RUN_ERROR: EventType.RUN_ERROR,
  STEP_STARTED: EventType.STEP_STARTED,
  STEP_FINISHED: EventType.STEP_FINISHED,

  // DEPRECATED: Legacy Meridian events - removed from backend, kept for reference
  // TURN_COMPLETE: 'turn_complete', // Use RUN_FINISHED instead
  // TURN_ERROR: 'turn_error',       // Use RUN_ERROR instead
} as const

export type SSEEventType = (typeof SSE_EVENTS)[keyof typeof SSE_EVENTS]

// ============================================================================
// Thinking Events with thinkingId
//
// Our backend extends AG-UI thinking events with thinkingId for tracking.
// The official AG-UI spec doesn't include thinkingId, so we define extended types.
// ============================================================================

export interface ThinkingStartEvent extends AGUIThinkingStartEvent {
  thinkingId: string
}

export interface ThinkingTextMessageStartEvent extends AGUIThinkingTextMessageStartEvent {
  thinkingId: string
}

export interface ThinkingTextMessageContentEvent extends AGUIThinkingTextMessageContentEvent {
  thinkingId?: string // Optional: some providers may omit this field
}

export interface ThinkingTextMessageEndEvent extends AGUIThinkingTextMessageEndEvent {
  thinkingId: string
}

export interface ThinkingEndEvent extends AGUIThinkingEndEvent {
  thinkingId: string
}

