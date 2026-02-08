/**
 * ThinkingGroupBlock - Collapsible container for thinking blocks and tool calls
 *
 * Groups consecutive thinking blocks and tool interactions into a single
 * collapsible section for cleaner UI presentation.
 *
 * Features:
 * - Rich header with preview text, tool count, and status indicator
 * - Collapsed by default, remembers expanded state
 * - Shows streaming indicator during active generation
 * - Error badge when any nested tool has an error
 */

import React, { useMemo } from "react";
import { Brain, ChevronDown, AlertTriangle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { cn } from "@/lib/utils";
import type { TurnBlock, ToolBlockContent } from "@/features/threads/types";
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
import {
  getToolInteractionReactKey,
  getTurnBlockReactKey,
} from "@/features/threads/utils/blockIdentity";

// Omit rehype-raw to prevent XML tags from being interpreted as HTML elements
const rehypePlugins = [
  defaultRehypePlugins.katex,
  defaultRehypePlugins.harden,
].filter(Boolean) as NonNullable<typeof defaultRehypePlugins.katex>[];

// =============================================================================
// TYPES
// =============================================================================

type ThinkingGroupItem =
  | { kind: "thinking"; block: TurnBlock }
  | { kind: "tool"; interaction: ToolInteraction };

interface ThinkingGroupBlockProps {
  groupId: string;
  items: ThinkingGroupItem[];
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
 * Get the last ~50 chars of thinking content for preview.
 */
function getThinkingPreview(items: ThinkingGroupItem[]): string | null {
  // Find the last thinking block with content
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.kind === "thinking" && item.block.textContent) {
      const text = item.block.textContent.trim();
      if (text.length === 0) continue;
      // Get last ~50 chars, breaking at word boundary if possible
      if (text.length <= 50) return text;
      const truncated = text.slice(-50);
      const spaceIndex = truncated.indexOf(" ");
      if (spaceIndex > 0 && spaceIndex < 20) {
        return "..." + truncated.slice(spaceIndex + 1);
      }
      return "..." + truncated;
    }
  }
  return null;
}

/**
 * Count tool interactions in the group.
 */
function countTools(items: ThinkingGroupItem[]): number {
  return items.filter((item) => item.kind === "tool").length;
}

/**
 * Check if any tool in the group has an error.
 */
function hasAnyError(items: ThinkingGroupItem[]): boolean {
  return items.some(
    (item) => item.kind === "tool" && hasToolError(item.interaction),
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export const ThinkingGroupBlock = React.memo(function ThinkingGroupBlock({
  groupId,
  items,
  turnId,
}: ThinkingGroupBlockProps) {
  // Get expanded state from UI store
  const { toggleThinkingGroup, expandedThinkingGroups } = useUIStore(
    useShallow((s) => ({
      toggleThinkingGroup: s.toggleThinkingGroup,
      expandedThinkingGroups: s.expandedThinkingGroups,
    })),
  );
  const isExpanded = expandedThinkingGroups.has(groupId);

  // Get sequence numbers for thinking blocks in this group
  const thinkingBlockSequences = useMemo(
    () =>
      items
        .filter(
          (item): item is { kind: "thinking"; block: TurnBlock } =>
            item.kind === "thinking",
        )
        .map((item) => item.block.sequence),
    [items],
  );

  // Use shared hook for streaming detection
  const isStreaming = useIsGroupStreaming(turnId, thinkingBlockSequences, [
    "thinking",
  ]);

  // Compute other derived values
  const { preview, toolCount, hasError } = useMemo(() => {
    return {
      preview: getThinkingPreview(items),
      toolCount: countTools(items),
      hasError: hasAnyError(items),
    };
  }, [items]);

  const handleToggle = () => {
    toggleThinkingGroup(groupId);
  };

  return (
    <Collapsible open={isExpanded} onOpenChange={handleToggle}>
      <div
        className={cn(
          "rounded-lg border",
          "bg-muted/20 hover:bg-muted/30",
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
            {/* Brain icon */}
            <Brain className="text-muted-foreground/70 h-3.5 w-3.5 shrink-0" />

            {/* Preview text */}
            <span
              className={cn(
                "text-muted-foreground min-w-0 flex-1 truncate text-sm",
                isStreaming && "animate-generating-shimmer",
              )}
            >
              {preview ?? "Thinking..."}
            </span>

            {/* Tool count badge */}
            {toolCount > 0 && (
              <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium">
                {toolCount} {toolCount === 1 ? "tool" : "tools"}
              </span>
            )}

            {/* Status indicator: checkmark only when tools present (tools have success/fail semantics) */}
            <span className="flex shrink-0 items-center gap-1">
              {hasError ? (
                <AlertTriangle className="text-error h-3.5 w-3.5" />
              ) : isStreaming ? (
                <span className="flex items-center gap-0.5">
                  <span className="animate-processing-dot bg-favorite h-1 w-1 rounded-full" />
                  <span className="animate-processing-dot bg-favorite h-1 w-1 rounded-full" />
                  <span className="animate-processing-dot bg-favorite h-1 w-1 rounded-full" />
                </span>
              ) : toolCount > 0 ? (
                <span className="text-success text-[11px]">✓</span>
              ) : null}
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
            {items.map((item, index) => {
              if (item.kind === "thinking") {
                // Render thinking content as plain text (not ThinkingBlock)
                // since the outer ThinkingGroupBlock is already collapsible
                return (
                  <div
                    key={getTurnBlockReactKey(item.block)}
                    className="text-muted-foreground text-sm break-words whitespace-pre-wrap"
                  >
                    <Streamdown rehypePlugins={rehypePlugins}>
                      {item.block.textContent ?? ""}
                    </Streamdown>
                  </div>
                );
              }

              // Tool interaction
              const toolName = getToolName(item.interaction);
              const render = getToolRenderer(toolName);
              const key =
                getToolInteractionReactKey(
                  turnId,
                  item.interaction.toolUse,
                  item.interaction.toolResult,
                ) ?? `tool-${index}`;

              return (
                <React.Fragment key={key}>
                  {render(
                    item.interaction.toolUse,
                    item.interaction.toolResult,
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});
