import { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface DocumentHeaderBarProps {
  leading?: ReactNode
  title?: ReactNode
  trailing?: ReactNode
  ariaLabel?: string
  showDivider?: boolean
}

/**
 * Consistent header bar for document-related right panel views
 * (explorer tree and editor). Provides aligned slots:
 * [leading] | [title/crumbs] | [trailing].
 */
export function DocumentHeaderBar({
  leading,
  title,
  trailing,
  ariaLabel = 'Document header',
  showDivider = false,
}: DocumentHeaderBarProps) {
  return (
    <div
      role="region"
      aria-label={ariaLabel}
      className={cn('flex items-center gap-2 px-3 py-4', showDivider && 'border-b')}
    >
      {leading}
      <div className="min-w-0 flex-1">{title}</div>
      {trailing}
    </div>
  )
}
