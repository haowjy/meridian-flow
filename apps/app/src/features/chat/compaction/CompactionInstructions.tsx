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
        "ml-[calc(0.875rem+var(--chat-space-block))] min-w-0 border-l-2 border-border-subtle pl-[var(--chat-space-block)]",
        "whitespace-pre-wrap break-words text-xs text-muted-foreground",
        className,
      )}
    >
      {instructions}
    </blockquote>
  );
}
