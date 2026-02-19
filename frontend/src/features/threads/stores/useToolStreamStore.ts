/**
 * useToolStreamStore - Dedicated store for tool streaming state
 *
 * Manages streaming tool state separately from turn/thread concerns.
 * Keyed by toolCallId (string) for stable lookup from components.
 *
 * State transitions:
 * - PREPARING: Tool call started, args streaming
 * - READY: Args complete, waiting for execution
 * - EXECUTING: Tool is being executed
 * - COMPLETE: Execution finished
 * - ERROR: Error occurred during streaming or execution
 */

import { create } from "zustand";

// Tool stream state constants (must match backend sse_events.go)
export const ToolStreamState = {
  PREPARING: "preparing",
  READY: "ready",
  EXECUTING: "executing",
  COMPLETE: "complete",
  ERROR: "error",
} as const;

export type ToolStreamStateValue =
  (typeof ToolStreamState)[keyof typeof ToolStreamState];

// Streaming tool data stored per tool call
export interface StreamingToolData {
  state: ToolStreamStateValue;
  toolName: string;
  toolCallId: string;
  toolUseId?: string; // AG-UI: Alias for toolCallId (backwards compat with block content)
  blockIndex: number;
  input?: Record<string, unknown>;
  error?: string;
  /**
   * Best-effort streaming metadata inferred from TOOL_CALL_ARGS deltas.
   * This is UI-only (not persisted) and exists to keep long tool inputs responsive.
   */
  argsTotalBytes?: number;
  argsJsonTruncated?: boolean;
  activeArgKey?: string | null;
  activeArgChars?: number;
  activeArgPreviewHead?: string;
  activeArgPreviewTail?: string;
}

interface ToolStreamStore {
  // State: toolCallId -> streaming data
  tools: Record<string, StreamingToolData>;

  // Actions (called by SSE handlers)
  clearAll: () => void;
  clearToolState: (toolCallId: string) => void; // SOLID I: Granular clear for single tool
  updateToolState: (
    toolCallId: string,
    update: Partial<StreamingToolData>,
  ) => void;
}

export const useToolStreamStore = create<ToolStreamStore>()((set) => ({
  tools: {},

  clearAll: () => {
    set({ tools: {} });
  },

  clearToolState: (toolCallId: string) => {
    set((state) => {
      if (!(toolCallId in state.tools)) return state;
      // SOLID I: Immutable update - create new object without the key
      const tools = { ...state.tools };
      delete tools[toolCallId];
      return { tools };
    });
  },

  updateToolState: (toolCallId: string, update: Partial<StreamingToolData>) => {
    set((state) => {
      const existing = state.tools[toolCallId];
      // If no existing entry, create one with the update values
      // This handles the case where startTool wasn't called first
      const base: StreamingToolData = existing || {
        state: ToolStreamState.PREPARING,
        toolName: "",
        toolCallId,
        blockIndex: -1,
      };

      // Filter out undefined values to preserve existing fields
      const filtered = Object.fromEntries(
        Object.entries(update).filter(([, v]) => v !== undefined),
      );

      return {
        tools: {
          ...state.tools,
          [toolCallId]: { ...base, ...filtered },
        },
      };
    });
  },
}));
