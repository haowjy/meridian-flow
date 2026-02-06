import React from "react";
import type { TurnBlock } from "@/features/threads/types";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { cn } from "@/lib/utils";

interface TextBlockProps {
  block: TurnBlock;
}

// Omit rehype-raw to prevent XML tags (e.g., <invoke>, <parameter>) from being
// interpreted as HTML elements. This can happen when LLM responses contain raw
// tool calling XML format.
const rehypePlugins = [
  defaultRehypePlugins.katex,
  defaultRehypePlugins.harden,
].filter(Boolean) as NonNullable<typeof defaultRehypePlugins.katex>[];

/**
 * Renders a text content block.
 *
 * This is the default block type for user and assistant messages.
 * Partial blocks (from interrupted streams) are shown with an amber indicator.
 */
export const TextBlock = React.memo(function TextBlock({
  block,
}: TextBlockProps) {
  const text = block.textContent ?? "";
  const isPartial = block.status === "partial";

  return (
    <div
      className={cn(
        "break-words whitespace-pre-wrap",
        isPartial && "border-l-2 border-amber-500 pl-2",
      )}
    >
      {isPartial && (
        <div className="mb-1 text-xs text-amber-600 italic dark:text-amber-400">
          Response was interrupted
        </div>
      )}
      <Streamdown
        className="break-words whitespace-pre-wrap"
        rehypePlugins={rehypePlugins}
      >
        {text}
      </Streamdown>
    </div>
  );
});
