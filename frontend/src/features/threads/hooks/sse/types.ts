/**
 * SSE Module Types
 *
 * Shared types for the SSE event handling system.
 */

import type { BlockType, Turn } from "@/features/threads/types";
import type { BlockTracker } from "../blockTracker";

/**
 * Context passed to all SSE event handlers.
 * Contains all dependencies needed to process events.
 */
export interface SSEDispatchContext {
  /** Current turn ID being streamed */
  turnId: string;
  /** Thread ID for refresh operations */
  threadId: string | null;
  /** Block index/type tracker */
  tracker: BlockTracker;
  /** Streaming text buffer */
  buffer: {
    append: (blockIndex: number, blockType: string, text: string) => void;
    flush: () => void;
  };
  /** Logger instance */
  logger: ReturnType<typeof import("@/core/lib/logger").makeLogger>;
  /** Abort controller for this stream */
  ctrl: AbortController;
}

/**
 * Store actions available to event handlers.
 * Accessed via getState() for stability.
 */
export interface SSEStoreActions {
  // Thread store actions
  appendStreamingTextDelta: (
    turnId: string,
    blockIndex: number,
    blockType: string,
    delta: string,
  ) => void;
  setStreamingBlockContent: (
    turnId: string,
    blockIndex: number,
    blockType: string,
    content: Record<string, unknown>,
  ) => void;
  clearStreamingStream: () => void;
  refreshTurn: (threadId: string, turnId: string) => Promise<void>;
  setStreamingBlockInfo: (
    blockIndex: number | null,
    blockType: BlockType | null,
  ) => void;
  notifyStreamEnded: (turnId: string) => void;

  // Interjection support
  setInterjectionContent: (content: string | null) => void;
  applyStreamSwitch: (
    prevTurnId: string,
    userTurn: Turn,
    assistantTurn: Turn,
    streamUrl: string,
  ) => void;

  // Tool stream store actions
  updateToolState: (
    toolCallId: string,
    update: Record<string, unknown>,
  ) => void;
  clearToolStates: () => void;
}

/**
 * Generic SSE event handler function type.
 */
export type SSEEventHandler<T = unknown> = (
  data: T,
  ctx: SSEDispatchContext,
  actions: SSEStoreActions,
) => void;
