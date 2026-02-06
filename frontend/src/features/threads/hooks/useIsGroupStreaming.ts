/**
 * useIsGroupStreaming - Shared hook for detecting if a group of blocks is streaming
 *
 * Centralizes streaming detection logic used by ThinkingGroupBlock and ToolGroupBlock
 * to determine if they should show streaming indicators (shimmer, dots, etc.).
 */

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useThreadStore } from "@/core/stores/useThreadStore";

/**
 * Hook to determine if a group of blocks is currently streaming.
 *
 * @param turnId - The turn ID this group belongs to
 * @param blockSequences - Array of sequence numbers for blocks in this group
 * @param validBlockTypes - Block types that would indicate streaming for this group
 * @returns boolean indicating if any block in this group is streaming
 */
export function useIsGroupStreaming(
  turnId: string,
  blockSequences: number[],
  validBlockTypes: string[],
): boolean {
  const { streamingTurnId, streamingBlockType, streamingBlockIndex } =
    useThreadStore(
      useShallow((s) => ({
        streamingTurnId: s.streamingTurnId,
        streamingBlockType: s.streamingBlockType,
        streamingBlockIndex: s.streamingBlockIndex,
      })),
    );

  return useMemo(() => {
    // Must be streaming in this turn
    if (streamingTurnId !== turnId) return false;

    // Must be streaming a valid block type for this group
    if (!validBlockTypes.includes(streamingBlockType ?? "")) return false;

    // Check if the streaming block is in this group
    return (
      streamingBlockIndex !== null &&
      blockSequences.includes(streamingBlockIndex)
    );
  }, [
    streamingTurnId,
    streamingBlockType,
    streamingBlockIndex,
    turnId,
    blockSequences,
    validBlockTypes,
  ]);
}
