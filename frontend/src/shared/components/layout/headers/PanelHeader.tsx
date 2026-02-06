import { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { HeaderGradientFade } from './HeaderGradientFade'

interface PanelHeaderProps {
  /** Content for the leading area (left side) */
  leading?: ReactNode
  /** Content for the trailing area (right side) */
  trailing?: ReactNode
  /** Show gradient fade below header (default: true) */
  showGradient?: boolean
  /** Show bottom border (default: false) */
  showBorder?: boolean
  /** Size variant: 'panel' = 48/56px, 'compact' = 36px (default: 'panel') */
  size?: 'panel' | 'compact'
  /** Make header sticky at top of scroll container (default: false) */
  sticky?: boolean
  /** Additional CSS classes */
  className?: string
  /** Accessibility label for the header region */
  ariaLabel?: string
}

/**
 * Unified panel header component for desktop panel views.
 *
 * Provides consistent layout across:
 * - ChatHeader (ThreadSelector + New button)
 * - ThreadListPanel ("Threads" label + New button)
 * - ProjectSettingsPanel ("Project Settings" label)
 * - ProjectHeader (Project name)
 * - EditorHeader (Breadcrumb + status)
 * - ThreadHeader (Thread breadcrumb)
 *
 * Layout:
 * [leading content] ----flex grow---- [trailing content]
 *
 * Note: Desktop only (hidden on mobile). Mobile views use MobilePanelHeader.
 */
export function PanelHeader({
  leading,
  trailing,
  showGradient = true,
  showBorder = false,
  size = 'panel',
  sticky = false,
  className,
  ariaLabel,
}: PanelHeaderProps) {
  return (
    <div
      role={ariaLabel ? 'region' : undefined}
      aria-label={ariaLabel}
      className={cn(
        'flex items-center gap-1 px-3 relative',
        size === 'panel' && 'h-14 md:h-[var(--panel-header-height)]',
        size === 'compact' && 'h-9',
        sticky && 'sticky top-0 z-20 bg-background',
        showBorder && 'border-b border-border/50',
        className
      )}
    >
      {/* Leading content (selector, title, toggle, etc.) */}
      <div className="flex items-center gap-1 min-w-0 flex-1">
        {leading}
      </div>

      {/* Trailing actions */}
      {trailing && (
        <div className="flex items-center gap-1 shrink-0">
          {trailing}
        </div>
      )}

      {showGradient && <HeaderGradientFade />}
    </div>
  )
}
