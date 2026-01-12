/**
 * CollapsibleToolBlock - Shared collapsible container for tool blocks
 *
 * Provides a consistent structure for tool blocks with:
 * - Collapsible header with icon, label, and status badge
 * - Optional action buttons (rendered OUTSIDE the trigger to avoid nested buttons)
 * - Expandable content area
 *
 * This component fixes the nested button issue by separating the trigger zone
 * from action buttons, following SRP (Single Responsibility Principle).
 */

import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/shared/components/ui/collapsible'

export interface CollapsibleToolBlockProps {
  /** Icon component to display in header */
  icon: LucideIcon
  /** Main label content (e.g., command + path) */
  label: React.ReactNode
  /** Status badge component */
  statusBadge: React.ReactNode
  /** Optional action buttons - rendered OUTSIDE trigger to avoid nested buttons */
  actions?: React.ReactNode
  /** Controlled expanded state */
  isExpanded: boolean
  /** Callback when expanded state changes */
  onExpandedChange: (expanded: boolean) => void
  /** Content to show when expanded */
  children: React.ReactNode
  /** Whether the tool is actively generating (shows border animation) */
  isGenerating?: boolean
}

export function CollapsibleToolBlock({
  icon: Icon,
  label,
  statusBadge,
  actions,
  isExpanded,
  onExpandedChange,
  children,
  isGenerating,
}: CollapsibleToolBlockProps) {
  return (
    <Collapsible open={isExpanded} onOpenChange={onExpandedChange}>
      <div
        className={cn(
          'rounded-lg border',
          'bg-card/50 hover:bg-card/80',
          'transition-colors duration-150',
          'overflow-hidden',
          isGenerating && 'animate-generating-border-shimmer'
        )}
      >
        {/* Header row - split into trigger zone and action zone */}
        <div className="flex items-center">
          {/* TRIGGER ZONE - handles expand/collapse */}
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className={cn(
                'flex flex-1 min-w-0 items-center gap-2 px-3 py-2',
                'text-left cursor-pointer',
                'hover:bg-muted/50 transition-colors'
              )}
            >
              <Icon className="h-3 w-3 shrink-0 text-muted-foreground/70" />
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {label}
              </div>
              {statusBadge}
            </button>
          </CollapsibleTrigger>

          {/* ACTION ZONE - styled segment matching trigger hover behavior */}
          {actions && (
            <div
              className={cn(
                'shrink-0 flex items-center self-stretch',
                'relative',
                'before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2',
                'before:h-4 before:w-px before:bg-muted-foreground/15',
                'px-2',
                'hover:bg-muted/50 transition-colors duration-150'
              )}
            >
              {actions}
            </div>
          )}
        </div>

        {/* Expanded content */}
        <CollapsibleContent>
          <div className="border-t px-3 py-3 space-y-2">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
