/**
 * Activity stream reducer — processes AG-UI events into ActivityBlockData.
 *
 * This is the bridge between the SSE event stream and the component tree.
 * Each event updates the state immutably; React re-renders on every dispatch.
 *
 * Key behaviors:
 * - Items appear in items[] as soon as their START event arrives
 * - Text/thinking items update in-place on CONTENT events (progressive rendering)
 * - Tool args accumulate and are partially parsed on each ARGS delta
 * - Pending text buffer flushes when a tool starts (text → tool transition)
 * - Parallel tools work naturally — each keyed by toolCallId
 */

import { parse as parsePartialJson, STR, OBJ, ARR, NUM } from "partial-json"

import type { ActivityBlockData, ActivityItem, ContentItem, ThinkingItem, ToolItem } from "../types"

import type { StreamEvent } from "./events"

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════

export type StreamState = {
  /** The activity block data consumed by the component tree. */
  activity: ActivityBlockData
  /** JSON buffers per tool call (accumulated TOOL_CALL_ARGS deltas). */
  toolArgsBuffers: Record<string, string>
}

export function createInitialState(id: string): StreamState {
  return {
    activity: { id, items: [], isStreaming: false },
    toolArgsBuffers: {},
  }
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/** Best-effort partial JSON parse. Returns undefined if nothing parseable yet. */
function tryParseArgs(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined

  try {
    const result = parsePartialJson(text, STR | OBJ | ARR | NUM)

    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, unknown>
    }

    return undefined
  } catch {
    return undefined
  }
}

/** Replace an item in the items array by id. Returns new array. */
function updateItemById<T extends ActivityItem>(
  items: ActivityItem[],
  id: string,
  updater: (item: T) => T,
): ActivityItem[] {
  return items.map((item) => (item.id === id ? updater(item as T) : item))
}

// ═══════════════════════════════════════════════════════════════════
// Reducer
// ═══════════════════════════════════════════════════════════════════

export function reduceStreamEvent(state: StreamState, event: StreamEvent): StreamState {
  switch (event.type) {
    // ---------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------

    case "RESET":
      return createInitialState(state.activity.id)

    case "RUN_STARTED":
      return {
        ...state,
        activity: { ...state.activity, isStreaming: true },
      }

    case "RUN_FINISHED":
      return {
        ...state,
        activity: { ...state.activity, isStreaming: false, pendingText: undefined },
      }

    // ---------------------------------------------------------------
    // Text messages
    //
    // START: insert empty ContentItem into items[]
    // CONTENT: update that ContentItem's text + set pendingText (collapsed view)
    // END: clear pendingText (text is finalized in items[])
    // ---------------------------------------------------------------

    case "TEXT_MESSAGE_START": {
      const textItem: ContentItem = { kind: "content", id: event.messageId, text: "" }
      return {
        ...state,
        activity: {
          ...state.activity,
          items: [...state.activity.items, textItem],
        },
      }
    }

    case "TEXT_MESSAGE_CONTENT": {
      const items = updateItemById<ContentItem>(state.activity.items, event.messageId, (item) => ({
        ...item,
        text: item.text + event.delta,
      }))
      // Text lives in items[] (rendered by TextRow inside the block).
      // Also set pendingText so consumers can show it outside the block
      // (e.g., as a streaming response below the activity).
      const updatedText = items.find((i) => i.id === event.messageId) as ContentItem | undefined
      return {
        ...state,
        activity: {
          ...state.activity,
          items,
          pendingText: updatedText?.text,
        },
      }
    }

    case "TEXT_MESSAGE_END":
      return {
        ...state,
        activity: { ...state.activity, pendingText: undefined },
      }

    // ---------------------------------------------------------------
    // Thinking
    //
    // Same pattern as text: insert on START, update on CONTENT, finalize on END.
    // ---------------------------------------------------------------

    case "THINKING_START": {
      const thinkingItem: ThinkingItem = { kind: "thinking", id: event.thinkingId, text: "" }
      return {
        ...state,
        activity: {
          ...state.activity,
          items: [...state.activity.items, thinkingItem],
        },
      }
    }

    case "THINKING_TEXT_CONTENT": {
      const items = updateItemById<ThinkingItem>(state.activity.items, event.thinkingId, (item) => ({
        ...item,
        text: item.text + event.delta,
      }))
      return {
        ...state,
        activity: { ...state.activity, items },
      }
    }

    case "THINKING_END":
      // Thinking item is already in items[] with full text. Nothing to do.
      return state

    // ---------------------------------------------------------------
    // Tool calls
    //
    // START: insert ToolItem with status "streaming-args"
    // ARGS: accumulate JSON, partial-parse for progressive summary
    // END: status → "executing"
    // RESULT: status → "done"/"error", set resultText
    //
    // Parallel tools work because each is keyed by toolCallId.
    // ---------------------------------------------------------------

    case "TOOL_CALL_START": {
      const tool: ToolItem = {
        kind: "tool",
        id: event.toolCallId,
        toolName: event.toolCallName,
        status: "streaming-args",
        argsText: "",
      }
      return {
        ...state,
        toolArgsBuffers: { ...state.toolArgsBuffers, [event.toolCallId]: "" },
        activity: {
          ...state.activity,
          items: [...state.activity.items, tool],
          // Clear pendingText — tool starts a new "section"
          pendingText: undefined,
        },
      }
    }

    case "TOOL_CALL_ARGS": {
      const buffer = (state.toolArgsBuffers[event.toolCallId] ?? "") + event.delta
      const parsedArgs = tryParseArgs(buffer)
      const items = updateItemById<ToolItem>(state.activity.items, event.toolCallId, (item) => ({
        ...item,
        argsText: buffer,
        ...(parsedArgs ? { parsedArgs } : {}),
      }))
      return {
        ...state,
        toolArgsBuffers: { ...state.toolArgsBuffers, [event.toolCallId]: buffer },
        activity: { ...state.activity, items },
      }
    }

    case "TOOL_CALL_END": {
      // Final parse of complete JSON
      const buffer = state.toolArgsBuffers[event.toolCallId] ?? ""
      let parsedArgs: Record<string, unknown> | undefined
      try {
        parsedArgs = JSON.parse(buffer) as Record<string, unknown>
      } catch {
        parsedArgs = tryParseArgs(buffer)
      }

      const { [event.toolCallId]: _discarded, ...remainingBuffers } = state.toolArgsBuffers
      const items = updateItemById<ToolItem>(state.activity.items, event.toolCallId, (item) => ({
        ...item,
        status: "executing",
        argsText: buffer,
        ...(parsedArgs ? { parsedArgs } : {}),
      }))
      return {
        ...state,
        toolArgsBuffers: remainingBuffers,
        activity: { ...state.activity, items },
      }
    }

    case "TOOL_CALL_RESULT": {
      const items = updateItemById<ToolItem>(state.activity.items, event.toolCallId, (item) => ({
        ...item,
        status: event.isError ? "error" : "done",
        resultText: event.resultText,
        isError: event.isError ?? false,
      }))
      return {
        ...state,
        activity: { ...state.activity, items },
      }
    }

    default:
      return state
  }
}
