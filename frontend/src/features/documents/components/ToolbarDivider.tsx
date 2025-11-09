import { cn } from '@/lib/utils'

interface ToolbarDividerProps {
  /**
   * If true, adds ml-auto to push subsequent elements to the right.
   * Used before the More button to create right-aligned section.
   */
  auto?: boolean
  className?: string
}

/**
 * Visual separator for toolbar button groups.
 * Consistent styling across all toolbar dividers.
 */
export function ToolbarDivider({ auto = false, className }: ToolbarDividerProps) {
  return (
    <div
      className={cn(
        'mx-0.5 h-4 w-px bg-border/40',
        auto && 'ml-auto',
        className
      )}
      aria-hidden="true"
    />
  )
}
