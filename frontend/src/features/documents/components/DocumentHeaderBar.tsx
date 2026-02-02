import { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'

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
      className={cn(
        'flex items-center gap-1 px-3 relative h-14 md:h-[var(--panel-header-height)]',
        showDivider && 'border-b border-border/70'
      )}
    >
      {leading}
      <div className="min-w-0 flex-1">{title}</div>
      {trailing}
      <HeaderGradientFade />
    </div>
  )
}
