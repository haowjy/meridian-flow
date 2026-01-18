/**
 * SSE Event Type Constants
 *
 * Uses official AG-UI types from @ag-ui/core for spec compliance.
 * Meridian-specific events (TURN_COMPLETE, TURN_ERROR) remain custom.
 *
 * Note: Thinking events with thinkingId are extended locally because
 * the official AG-UI spec doesn't include thinkingId tracking.
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

// Re-export official types (these match our backend 1:1)
export type {
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
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

  // AG-UI Lifecycle Events
  RUN_STARTED: EventType.RUN_STARTED,
  RUN_FINISHED: EventType.RUN_FINISHED,
  RUN_ERROR: EventType.RUN_ERROR,
  STEP_STARTED: EventType.STEP_STARTED,
  STEP_FINISHED: EventType.STEP_FINISHED,

  // Meridian-specific Events (kept for backward compatibility)
  TURN_COMPLETE: 'turn_complete',
  TURN_ERROR: 'turn_error',
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

// ============================================================================
// Meridian-specific Events (not in official AG-UI spec)
// ============================================================================

export interface TurnCompleteEvent {
  turn_id: string
  stop_reason?: string
}

export interface TurnErrorEvent {
  turn_id: string
  error: string
  is_cancelled?: boolean // User cancelled streaming (don't show error toast)
}
