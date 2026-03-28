import { cn } from "@/lib/utils"

interface WordCountProps {
  /** Total document word count */
  totalWords: number
  /** Selected text word count (0 when no selection) */
  selectionWords?: number
  className?: string
}

/** Format a number with thousands separator (e.g., 1847 -> "1,847") */
function formatNumber(n: number): string {
  return n.toLocaleString()
}

/**
 * Word count display for the title header.
 *
 * Shows `1,847 words` normally. When text is selected, shows
 * `127 / 1,847 words` so the writer can see how much of the
 * document they've selected.
 */
export function WordCount({
  totalWords,
  selectionWords = 0,
  className,
}: WordCountProps) {
  const hasSelection = selectionWords > 0

  return (
    <span
      className={cn("text-xs text-muted-foreground tabular-nums", className)}
      aria-label={
        hasSelection
          ? `${formatNumber(selectionWords)} of ${formatNumber(totalWords)} words selected`
          : `${formatNumber(totalWords)} words`
      }
    >
      {hasSelection && (
        <>
          <span className="text-foreground/70">
            {formatNumber(selectionWords)}
          </span>
          <span className="mx-0.5">/</span>
        </>
      )}
      {formatNumber(totalWords)} words
    </span>
  )
}
