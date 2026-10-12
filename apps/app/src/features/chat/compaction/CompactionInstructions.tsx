/**
 * The writer's `/compact <instructions>`, verbatim, under a queued command or
 * the divider it became. Indented to the state words so the rule's icon keeps
 * the edge; the quote bar ties it to the line above without another label.
 */
import { cn } from "@/lib/utils";

export function CompactionInstructions({
  instructions,
  className,
}: {
  instructions: string;
  className?: string;
}) {
  return (
    <blockquote
      data-compaction-instructions
      className={cn(
        // size-3.5 icon plus the row's gap: the quote starts under the words.
        "ml-[calc(0.875rem+var(--chat-space-block))] min-w-0 border-l-2 border-border-subtle pl-[var(--chat-space-block)]",
        "whitespace-pre-wrap break-words text-meta text-ink-muted",
        className,
      )}
    >
      {instructions}
    </blockquote>
  );
}
