import React, { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  Turn,
  TurnBlock,
  ToolBlockContent,
} from "@/features/threads/types";
import { useThreadStore } from "@/core/stores/useThreadStore";
import { TurnActionBar } from "./TurnActionBar";
import { BlockRenderer } from "./blocks";
import { InlineError } from "@/shared/components/InlineError";
import { makeLogger } from "@/core/lib/logger";
import {
  buildAssistantRenderItems,
  groupThinkingAndTools,
  groupStandaloneTools,
} from "@/features/threads/utils/toolGrouping";
import { getToolRenderer } from "./blocks/toolRegistry";
import {
  getToolInteractionReactKey,
  getTurnBlockReactKey,
  getThinkingGroupReactKey,
  getToolGroupReactKey,
} from "@/features/threads/utils/blockIdentity";
import { ThinkingGroupBlock } from "./blocks/ThinkingGroupBlock";
import { ToolGroupBlock } from "./blocks/ToolGroupBlock";

const log = makeLogger("AssistantTurn");

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract tool name from tool_use or tool_result block.
 * Used to route to appropriate custom tool UI via registry.
 */
function getToolName(
  toolUse: TurnBlock | null,
  toolResult: TurnBlock | null,
): string | null {
  const source = toolUse ?? toolResult;
  if (!source?.content) return null;
  const content = source.content as ToolBlockContent;
  return typeof content.toolName === "string" ? content.toolName : null;
}

// =============================================================================
// COMPONENT
// =============================================================================

interface AssistantTurnProps {
  turn: Turn;
}

/**
 * Assistant turn content.
 *
 * Single responsibility:
 * - Render assistant content as left-aligned blocks within the thread column.
 * - Handle actions (regenerate, navigate).
 *
 * The BlockRenderer pattern allows easy extension for new block types
 * (thinking, tool use, citations, etc.) without modifying this component.
 *
 * Performance: Memoized to prevent unnecessary re-renders when turn data unchanged.
 */
export const AssistantTurn = React.memo(function AssistantTurn({
  turn,
}: AssistantTurnProps) {
  const {
    switchSibling,
    regenerateTurn,
    isLoadingTurns,
    isSwitchingSibling,
    streamingTurnId,
  } = useThreadStore(
    useShallow((s) => ({
      switchSibling: s.switchSibling,
      regenerateTurn: s.regenerateTurn,
      isLoadingTurns: s.isLoadingTurns,
      isSwitchingSibling: s.isSwitchingSibling,
      streamingTurnId: s.streamingTurnId,
    })),
  );

  // true if ANY turn is streaming (disables actions globally)
  const isStreaming = streamingTurnId !== null;
  // true if THIS turn is streaming (shows dots indicator)
  const isStreamingThisTurn = streamingTurnId === turn.id;

  log.debug("render", {
    id: turn.id,
    prevTurnId: turn.prevTurnId,
    blocks: turn.blocks.length,
  });

  const handleNavigate = useCallback(
    (turnId: string) => {
      switchSibling(turn.threadId, turnId);
    },
    [switchSibling, turn.threadId],
  );

  const handleRegenerate = useCallback(() => {
    if (turn.prevTurnId) {
      regenerateTurn(turn.threadId, turn.id);
    }
  }, [regenerateTurn, turn.threadId, turn.prevTurnId, turn.id]);

  // Build and group render items
  const items = useMemo(() => {
    const rawItems = buildAssistantRenderItems(turn.blocks);
    const withThinkingGroups = groupThinkingAndTools(rawItems, turn.id);
    return groupStandaloneTools(withThinkingGroups, turn.id);
  }, [turn.blocks, turn.id]);

  return (
    <div
      className="group flex min-w-0 flex-col items-stretch gap-1 text-sm"
      data-turn-id={turn.id}
    >
      <div className="w-full min-w-0 space-y-2 overflow-hidden">
        {items.map((item, index) => {
          if (item.kind === "block") {
            return (
              <BlockRenderer
                key={getTurnBlockReactKey(item.block)}
                block={item.block}
              />
            );
          }

          if (item.kind === "thinkingGroup") {
            return (
              <ThinkingGroupBlock
                key={getThinkingGroupReactKey(item.groupId)}
                groupId={item.groupId}
                items={item.items}
                turnId={turn.id}
              />
            );
          }

          if (item.kind === "toolGroup") {
            return (
              <ToolGroupBlock
                key={getToolGroupReactKey(item.groupId)}
                groupId={item.groupId}
                items={item.items}
                turnId={turn.id}
              />
            );
          }

          // Route to custom tool UI via registry (extensible pattern)
          const toolName = getToolName(item.toolUse, item.toolResult);
          const render = getToolRenderer(toolName);
          const key =
            getToolInteractionReactKey(
              turn.id,
              item.toolUse,
              item.toolResult,
            ) ?? `tool-${index}`;

          return (
            <React.Fragment key={key}>
              {render(item.toolUse, item.toolResult)}
            </React.Fragment>
          );
        })}

        {/* Still processing indicator - shows only on the actively streaming turn */}
        {isStreamingThisTurn && (
          <div className="text-favorite flex items-center gap-1.5 py-2">
            <span className="animate-processing-dot h-1.5 w-1.5 rounded-full bg-current" />
            <span className="animate-processing-dot h-1.5 w-1.5 rounded-full bg-current" />
            <span className="animate-processing-dot h-1.5 w-1.5 rounded-full bg-current" />
          </div>
        )}

        {/* Show turn-level error inline (no retry - most turn errors are config issues, not transient) */}
        {turn.error && <InlineError message={turn.error} />}
      </div>

      <TurnActionBar
        turn={turn}
        isLoading={isLoadingTurns || isSwitchingSibling || isStreaming}
        onNavigate={handleNavigate}
        onRegenerate={turn.prevTurnId ? handleRegenerate : undefined}
        className="ml-0"
      />
    </div>
  );
});
