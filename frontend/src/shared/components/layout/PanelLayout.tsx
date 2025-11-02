import { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface PanelLayoutProps {
  left: ReactNode
  center: ReactNode
  right: ReactNode
  leftCollapsed?: boolean
  rightCollapsed?: boolean
  onLeftCollapse?: () => void
  onRightCollapse?: () => void
  className?: string
}

/**
 * Three-panel layout for workspace (Chat List | Active Chat | Documents).
 * Handles panel collapsing and responsive sizing.
 *
 * Layout: 25% | 50% | 25% (when all expanded)
 */
export function PanelLayout({
  left,
  center,
  right,
  leftCollapsed = false,
  rightCollapsed = false,
  onLeftCollapse,
  onRightCollapse,
  className,
}: PanelLayoutProps) {
  return (
    <div className={cn('flex h-full w-full overflow-hidden', className)}>
      {/* Left Panel (25% or collapsed) */}
      <div
        className={cn(
          'flex-shrink-0 border-r transition-all duration-300',
          leftCollapsed ? 'w-0' : 'w-1/4'
        )}
      >
        {!leftCollapsed && left}
      </div>

      {/* Center Panel (50% or expanded if sides collapsed) */}
      <div className="flex-1 overflow-hidden">{center}</div>

      {/* Right Panel (25% or collapsed) */}
      <div
        className={cn(
          'flex-shrink-0 border-l transition-all duration-300',
          rightCollapsed ? 'w-0' : 'w-1/4'
        )}
      >
        {!rightCollapsed && right}
      </div>
    </div>
  )
}
