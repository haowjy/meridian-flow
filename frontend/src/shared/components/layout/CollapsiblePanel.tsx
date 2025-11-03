import { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'

interface CollapsiblePanelProps {
  children: ReactNode
  collapsed: boolean
  onToggle: () => void
  side: 'left' | 'right'
  title?: string
  className?: string
}

/**
 * Panel wrapper with collapse toggle button.
 * Shows collapse/expand button at appropriate edge.
 */
export function CollapsiblePanel({
  children,
  collapsed,
  onToggle,
  side,
  title,
  className,
}: CollapsiblePanelProps) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  const ExpandIcon = side === 'left' ? ChevronRight : ChevronLeft
  // Collapse buttons always on left when expanded; expand buttons on opposite edges when collapsed
  const buttonSideClass = collapsed
    ? (side === 'left' ? 'right-2' : 'left-2')
    : 'left-2'

  const panelLabel = title || `${side} panel`
  const panelId = `${side}-panel`
  const ariaLabel = collapsed
    ? `Expand ${panelLabel.toLowerCase()}`
    : `Collapse ${panelLabel.toLowerCase()}`

  return (
    <div className={cn('relative flex h-full flex-col', className)}>
      {/* Collapse Toggle Button */}
      <div className={cn('absolute top-2 z-10', buttonSideClass)}>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          className="h-8 w-8"
          aria-label={ariaLabel}
          aria-expanded={!collapsed}
          aria-controls={panelId}
          title={ariaLabel}
        >
          {collapsed ? <ExpandIcon className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
        </Button>
      </div>

      {/* Panel Content */}
      {!collapsed && (
        <div
          id={panelId}
          role="region"
          aria-label={panelLabel}
          className="flex h-full flex-col overflow-hidden"
        >
          {title && (
            <div className="border-b py-3 pl-12 pr-4">
              <h2 className="text-sm font-semibold">{title}</h2>
            </div>
          )}
          <div className="flex-1 overflow-auto">{children}</div>
        </div>
      )}
    </div>
  )
}
