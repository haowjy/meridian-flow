import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SectionHeaderProps {
  title: string
  subtitle?: string
  /** Icon to display before title */
  icon?: ReactNode
  /** Count badge (e.g., item count) */
  count?: number
  /** Action element (e.g., button) for the right side */
  action?: ReactNode
  /** Size variant: 'default' has margin-bottom, 'compact' has smaller text */
  size?: 'default' | 'compact'
}

/**
 * Page section header with optional icon, count, and action.
 *
 * Used for:
 * - Page sections with h1 display title
 * - Feature area headers with counts (e.g., "Documents (5)")
 *
 * Layout:
 * [icon?] [title] [count?] ----flex grow---- [action?]
 */
export function SectionHeader({
  title,
  subtitle,
  icon,
  count,
  action,
  size = 'default',
}: SectionHeaderProps) {
  const isCompact = size === 'compact'

  return (
    <div className={cn(!isCompact && 'mb-4')}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <h1 className={cn(
              isCompact
                ? 'type-label uppercase tracking-wide text-muted-foreground'
                : 'type-display'
            )}>
              {title}
            </h1>
            {subtitle && !isCompact && (
              <p className="mt-1 type-body text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {typeof count === 'number' && (
            <span className={cn(
              'text-muted-foreground',
              isCompact ? 'type-meta' : 'type-body'
            )}>
              ({count})
            </span>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  )
}
