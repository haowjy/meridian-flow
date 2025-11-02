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

  return (
    <div className={cn('relative flex h-full flex-col', className)}>
      {/* Collapse Toggle Button */}
      <div className="absolute right-2 top-2 z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          className="h-8 w-8"
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          {collapsed ? <ExpandIcon className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
        </Button>
      </div>

      {/* Panel Content */}
      {!collapsed && (
        <div className="flex h-full flex-col overflow-hidden">
          {title && (
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-semibold">{title}</h2>
            </div>
          )}
          <div className="flex-1 overflow-auto">{children}</div>
        </div>
      )}
    </div>
  )
}
