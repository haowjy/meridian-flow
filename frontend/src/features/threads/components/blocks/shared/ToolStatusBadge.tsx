/**
 * ToolStatusBadge - Status indicator for tool blocks
 *
 * Displays a styled badge showing the current status of a tool operation.
 * Uses semantic theme colors for proper contrast in light/dark modes.
 * Animates with shimmer effect when in pending state.
 */

import { cn } from '@/lib/utils'

export type ToolStatus = 'pending' | 'success' | 'error'

export interface ToolStatusBadgeProps {
  status: ToolStatus
  label: string
}

const STATUS_STYLES: Record<ToolStatus, string> = {
  pending: 'bg-muted text-muted-foreground border-muted-foreground/30',
  success: 'bg-success/15 text-success border-success/30',
  error: 'bg-error/15 text-error border-error/30',
}

export function ToolStatusBadge({ status, label }: ToolStatusBadgeProps) {
  const isPending = status === 'pending'

  return (
    <span
      className={cn(
        'shrink-0 text-[11px] font-medium',
        'px-2 py-0.5 rounded-full border',
        STATUS_STYLES[status],
        // Apply shimmer animation when pending
        isPending && 'animate-generating-shimmer'
      )}
    >
      {label}
    </span>
  )
}
