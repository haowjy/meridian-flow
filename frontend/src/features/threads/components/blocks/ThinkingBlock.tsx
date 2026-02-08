import React from "react";
import { cn } from "@/lib/utils";
import type { TurnBlock } from "@/features/threads/types";
import { useCurrentThreadStream } from "@/core/stores/useStreamStore";
import { Streamdown, defaultRehypePlugins } from "streamdown";

// Omit rehype-raw to prevent XML tags from being interpreted as HTML elements
const rehypePlugins = [
  defaultRehypePlugins.katex,
  defaultRehypePlugins.harden,
].filter(Boolean) as NonNullable<typeof defaultRehypePlugins.katex>[];

interface ThinkingBlockProps {
  block: TurnBlock;
}

/**
 * Renders a thinking block (Claude's internal reasoning).
 *
 * TODO: Implement collapsible thinking blocks for Claude's reasoning process.
 * This is a placeholder for future extended thinking feature.
 */
export const ThinkingBlock = React.memo(function ThinkingBlock({
  block,
}: ThinkingBlockProps) {
  const text = block.textContent ?? "";

  const { streamingTurnId, streamingBlockIndex, streamingBlockType } =
    useCurrentThreadStream();

  const isStreamingThinking =
    streamingTurnId === block.turnId &&
    streamingBlockType === "thinking" &&
    streamingBlockIndex === block.sequence;

  return (
    <details
      className={cn(
        "bg-muted/30 text-muted-foreground my-2 rounded border-l-2 text-sm",
        isStreamingThinking
          ? "animate-generating-border-shimmer"
          : "border-muted-foreground/30",
      )}
    >
      <summary className="cursor-pointer px-3 py-2 font-medium">
        <span
          className={
            isStreamingThinking ? "animate-generating-shimmer" : undefined
          }
        >
          Thinking...
        </span>
      </summary>
      <div className="mt-1 px-3 pb-3 break-words whitespace-pre-wrap">
        <Streamdown
          className="break-words whitespace-pre-wrap"
          rehypePlugins={rehypePlugins}
        >
          {text}
        </Streamdown>
      </div>
    </details>
  );
});
