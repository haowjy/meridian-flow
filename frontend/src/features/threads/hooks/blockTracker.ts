/**
 * BlockTracker manages correlation between AG-UI event IDs and block indices.
 *
 * Consolidates toolCallId, messageId, and thinkingId tracking into one abstraction.
 * Provides single clear() method to prevent memory leaks when streams end.
 *
 * This class solves:
 * - 4 separate Maps → 1 class with single cleanup
 * - Scattered JSON buffer management → centralized in one place
 * - Block index + type tracking → consistent interface
 */

import type { BlockType } from "@/features/threads/types";
import {
  ToolArgsStreamTracker,
  type ToolArgsStreamSnapshot,
} from "@/features/threads/utils/toolArgsStreamTracker";

export class BlockTracker {
  // ============================================================================
  // Tool Call Tracking
  // Maps toolCallId -> blockIndex for TOOL_CALL_ARGS/END correlation
  // ============================================================================
  private toolCalls = new Map<string, number>();
  private toolJsonBuffers = new Map<string, string>();
  private toolJsonTruncated = new Set<string>();
  private toolArgsTrackers = new Map<string, ToolArgsStreamTracker>();

  // ============================================================================
  // Message Tracking
  // Maps messageId -> blockIndex for TEXT_MESSAGE_CONTENT/END correlation
  // ============================================================================
  private messages = new Map<string, number>();

  // ============================================================================
  // Thinking Tracking
  // Maps thinkingId -> blockIndex for THINKING_* event correlation
  // ============================================================================
  private thinking = new Map<string, number>();
  private activeThinkingId: string | null = null;

  // ============================================================================
  // Current Block State
  // Tracks the currently active block for streaming deltas
  // ============================================================================
  private currentBlockIndex = -1;
  private currentBlockType: BlockType | null = null;

  // ============================================================================
  // Block Index Management
  // ============================================================================

  /**
   * Initialize the block index from a known sequence number.
   * Used on reconnection when RUN_STARTED includes lastBlockSequence.
   * New blocks will start from lastSequence + 1.
   */
  initializeFromSequence(lastSequence: number): void {
    this.currentBlockIndex = lastSequence;
  }

  /**
   * Get the next block index and set it as current.
   * Call this when starting a new block (TEXT_MESSAGE_START, TOOL_CALL_START, etc.)
   */
  nextBlockIndex(): number {
    this.currentBlockIndex++;
    return this.currentBlockIndex;
  }

  /**
   * Get the current block index, or null if no block has been started.
   */
  getCurrentBlockIndex(): number | null {
    return this.currentBlockIndex >= 0 ? this.currentBlockIndex : null;
  }

  /**
   * Set the current block type for content routing.
   */
  setCurrentBlockType(type: BlockType | null): void {
    this.currentBlockType = type;
  }

  /**
   * Get the current block type.
   */
  getCurrentBlockType(): BlockType | null {
    return this.currentBlockType;
  }

  // ============================================================================
  // Tool Call Tracking
  // ============================================================================

  /**
   * Register a new tool call with its block index.
   * Also initializes the JSON buffer for accumulating tool arguments.
   */
  registerToolCall(toolCallId: string, blockIndex: number): void {
    this.toolCalls.set(toolCallId, blockIndex);
    this.toolJsonBuffers.set(toolCallId, "");
    this.toolJsonTruncated.delete(toolCallId);
    this.toolArgsTrackers.set(toolCallId, new ToolArgsStreamTracker());
  }

  /**
   * Get the block index for a tool call ID.
   */
  getToolCallBlockIndex(toolCallId: string): number | undefined {
    return this.toolCalls.get(toolCallId);
  }

  /**
   * Append JSON delta to the tool call's buffer and return the accumulated JSON.
   */
  appendToolJson(
    toolCallId: string,
    delta: string,
    opts?: { maxChars?: number },
  ): { json: string; truncated: boolean } {
    if (this.toolJsonTruncated.has(toolCallId)) {
      return {
        json: this.toolJsonBuffers.get(toolCallId) ?? "",
        truncated: true,
      };
    }

    const current = this.toolJsonBuffers.get(toolCallId) ?? "";
    const maxChars = opts?.maxChars;
    if (typeof maxChars === "number" && maxChars > 0) {
      if (current.length >= maxChars) {
        this.toolJsonTruncated.add(toolCallId);
        return { json: current, truncated: true };
      }

      const remaining = maxChars - current.length;
      if (delta.length > remaining) {
        const updated = current + delta.slice(0, remaining);
        this.toolJsonBuffers.set(toolCallId, updated);
        this.toolJsonTruncated.add(toolCallId);
        return { json: updated, truncated: true };
      }
    }

    const updated = current + delta;
    this.toolJsonBuffers.set(toolCallId, updated);
    return { json: updated, truncated: false };
  }

  /**
   * Get the accumulated JSON for a tool call.
   */
  getToolJson(toolCallId: string): string {
    return this.toolJsonBuffers.get(toolCallId) ?? "";
  }

  /**
   * Remove a tool call from tracking (call on TOOL_CALL_END).
   * Returns the final accumulated JSON.
   */
  removeToolCall(toolCallId: string): string {
    const json = this.toolJsonBuffers.get(toolCallId) ?? "";
    this.toolCalls.delete(toolCallId);
    this.toolJsonBuffers.delete(toolCallId);
    this.toolJsonTruncated.delete(toolCallId);
    this.toolArgsTrackers.delete(toolCallId);
    return json;
  }

  /**
   * Append tool args delta to the incremental arg tracker.
   * Returns a snapshot of inferred streaming metadata (active key + preview).
   */
  appendToolArgsDelta(
    toolCallId: string,
    delta: string,
  ): ToolArgsStreamSnapshot | null {
    const tracker = this.toolArgsTrackers.get(toolCallId);
    if (!tracker) return null;
    return tracker.append(delta);
  }

  isToolJsonTruncated(toolCallId: string): boolean {
    return this.toolJsonTruncated.has(toolCallId);
  }

  // ============================================================================
  // Message Tracking
  // ============================================================================

  /**
   * Register a new message with its block index.
   */
  registerMessage(messageId: string, blockIndex: number): void {
    this.messages.set(messageId, blockIndex);
  }

  /**
   * Get the block index for a message ID.
   */
  getMessageBlockIndex(messageId: string): number | undefined {
    return this.messages.get(messageId);
  }

  /**
   * Remove a message from tracking (call on TEXT_MESSAGE_END).
   */
  removeMessage(messageId: string): void {
    this.messages.delete(messageId);
  }

  // ============================================================================
  // Thinking Tracking
  // ============================================================================

  /**
   * Register a new thinking block with its block index.
   */
  registerThinking(thinkingId: string, blockIndex: number): void {
    this.thinking.set(thinkingId, blockIndex);
    this.activeThinkingId = thinkingId;
  }

  /**
   * Get the block index for a thinking ID.
   */
  getThinkingBlockIndex(thinkingId: string): number | undefined {
    return this.thinking.get(thinkingId);
  }

  /**
   * Remove a thinking block from tracking (call on THINKING_END).
   */
  removeThinking(thinkingId: string): void {
    this.thinking.delete(thinkingId);
    if (this.activeThinkingId === thinkingId) {
      this.activeThinkingId = null;
    }
  }

  /**
   * Returns the currently active thinking block index (best-effort).
   * Used when providers omit thinkingId on THINKING_TEXT_MESSAGE_CONTENT.
   */
  getActiveThinkingBlockIndex(): number | undefined {
    if (!this.activeThinkingId) return undefined;
    return this.thinking.get(this.activeThinkingId);
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Clear all tracking state.
   * Call this on turn_complete, turn_error, or stream close to prevent memory leaks.
   */
  clear(): void {
    this.toolCalls.clear();
    this.toolJsonBuffers.clear();
    this.toolJsonTruncated.clear();
    this.toolArgsTrackers.clear();
    this.messages.clear();
    this.thinking.clear();
    this.activeThinkingId = null;
    this.currentBlockIndex = -1;
    this.currentBlockType = null;
  }
}
