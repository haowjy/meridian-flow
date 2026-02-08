/**
 * ToolGroupBlock - Collapsible container for consecutive standalone tool calls
 *
 * Groups consecutive tool interactions (not part of a thinking group) into a
 * single collapsible section for cleaner UI presentation.
 *
 * Features:
 * - Collapsed by default, remembers expanded state
 * - Shows streaming indicator during active generation
 * - Error badge when any nested tool has an error
 * - Aggregate status display (completed, streaming, error)
 */

import React, { useMemo } from "react";
import { Wrench, ChevronDown, AlertTriangle, Check } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import type { ToolBlockContent } from "@/features/threads/types";
import type { ToolInteraction } from "@/features/threads/utils/toolGrouping";
import { useUIStore } from "@/core/stores/useUIStore";
import { useIsGroupStreaming } from "@/features/threads/hooks/useIsGroupStreaming";
import { threadToolContentPadding, threadToolHeaderPadding } from "../styles";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/shared/components/ui/collapsible";
import { getToolRenderer } from "./toolRegistry";
import { getToolInteractionReactKey } from "@/features/threads/utils/blockIdentity";

// =============================================================================
// TYPES
// =============================================================================

interface ToolGroupBlockProps {
  groupId: string;
  items: ToolInteraction[];
  turnId: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract tool name from a tool interaction for routing to registry.
 */
function getToolName(interaction: ToolInteraction): string | null {
  const source = interaction.toolUse ?? interaction.toolResult;
  if (!source?.content) return null;
  const content = source.content as ToolBlockContent;
  return typeof content.toolName === "string" ? content.toolName : null;
}

/**
 * Check if a tool interaction has an error.
 */
function hasToolError(interaction: ToolInteraction): boolean {
  if (!interaction.toolResult?.content) return false;
  const content = interaction.toolResult.content as ToolBlockContent;
  return content.isError === true;
}

/**
 * Check if a tool interaction is complete (has a result).
 */
function isToolComplete(interaction: ToolInteraction): boolean {
  return interaction.toolResult !== null;
}

/**
 * Check if any tool in the group has an error.
 */
function hasAnyError(items: ToolInteraction[]): boolean {
  return items.some(hasToolError);
}

/**
 * Check if all tools in the group are complete.
 */
function areAllToolsComplete(items: ToolInteraction[]): boolean {
  return items.every(isToolComplete);
}

// =============================================================================
// COMPONENT
// =============================================================================

export const ToolGroupBlock = React.memo(function ToolGroupBlock({
  groupId,
  items,
  turnId,
}: ToolGroupBlockProps) {
  // Get expanded state from UI store
  const { toggleToolGroup, expandedToolGroups } = useUIStore(
    useShallow((s) => ({
      toggleToolGroup: s.toggleToolGroup,
      expandedToolGroups: s.expandedToolGroups,
    })),
  );
  const isExpanded = expandedToolGroups.has(groupId);

  // Get sequence numbers for all tool blocks in this group
  const toolBlockSequences = useMemo(
    () =>
      items
        .flatMap((interaction) => [
          interaction.toolUse?.sequence,
          interaction.toolResult?.sequence,
        ])
        .filter((seq): seq is number => seq !== undefined),
    [items],
  );

  // Use shared hook for streaming detection
  const isStreaming = useIsGroupStreaming(turnId, toolBlockSequences, [
    "tool_use",
    "tool_result",
  ]);

  // Compute other derived values
  const { hasError, allComplete } = useMemo(() => {
    return {
      hasError: hasAnyError(items),
      allComplete: areAllToolsComplete(items),
    };
  }, [items]);

  const handleToggle = () => {
    toggleToolGroup(groupId);
  };

  const toolCount = items.length;

  return (
    <Collapsible open={isExpanded} onOpenChange={handleToggle}>
      <div
        className={cn(
          "rounded-lg border",
          "bg-card/50 hover:bg-card/80",
          "transition-colors duration-150",
          "overflow-hidden",
          isStreaming && "animate-generating-border-shimmer",
        )}
      >
        {/* Header */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2",
              threadToolHeaderPadding,
              "cursor-pointer text-left",
              "hover:bg-muted/40 transition-colors",
            )}
          >
            {/* Wrench icon */}
            <Wrench className="text-muted-foreground/70 h-3.5 w-3.5 shrink-0" />

            {/* Tool count label */}
            <span
              className={cn(
                "text-muted-foreground min-w-0 flex-1 text-sm",
                isStreaming && "animate-generating-shimmer",
              )}
            >
              {toolCount} {toolCount === 1 ? "tool" : "tools"}
            </span>

            {/* Status indicator */}
            <span className="flex shrink-0 items-center gap-1">
              {hasError ? (
                <AlertTriangle className="text-error h-3.5 w-3.5" />
              ) : isStreaming ? (
                <span className="flex items-center gap-0.5">
                  <span className="animate-processing-dot bg-favorite h-1 w-1 rounded-full" />
                  <span className="animate-processing-dot bg-favorite h-1 w-1 rounded-full" />
                  <span className="animate-processing-dot bg-favorite h-1 w-1 rounded-full" />
                </span>
              ) : allComplete ? (
                <Check className="text-success h-3.5 w-3.5" />
              ) : (
                <span className="text-muted-foreground text-[11px]">...</span>
              )}
            </span>

            {/* Chevron */}
            <ChevronDown
              className={cn(
                "text-muted-foreground/50 h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                isExpanded && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>

        {/* Expanded content */}
        <CollapsibleContent>
          <div className={cn("space-y-2 border-t", threadToolContentPadding)}>
            {items.map((interaction, index) => {
              const toolName = getToolName(interaction);
              const render = getToolRenderer(toolName);
              const key =
                getToolInteractionReactKey(
                  turnId,
                  interaction.toolUse,
                  interaction.toolResult,
                ) ?? `tool-${index}`;

              return (
                <React.Fragment key={key}>
                  {render(interaction.toolUse, interaction.toolResult)}
                </React.Fragment>
              );
            })}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});
