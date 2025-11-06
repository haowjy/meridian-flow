import { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { CollapsiblePanelProvider } from './CollapsiblePanelContext'

interface CollapsiblePanelProps {
  children: ReactNode
  collapsed: boolean
  onToggle: () => void
  side: 'left' | 'right'
  className?: string
}

/**
 * Panel wrapper with collapse toggle button.
 * Children can opt-in to custom button positioning via useCollapsiblePanel() hook.
 * If children don't render the button, falls back to default floating position.
 */
export function CollapsiblePanel({
  children,
  collapsed,
  onToggle,
  side,
  className,
}: CollapsiblePanelProps) {
  return (
    <CollapsiblePanelProvider
      collapsed={collapsed}
      onToggle={onToggle}
      side={side}
    >
      <div className={cn('relative flex h-full flex-col', className)}>
        {/* Panel Content */}
        {!collapsed && (
          <div
            id={`${side}-panel`}
            role="region"
            aria-label={`${side} panel`}
            className="flex h-full flex-col overflow-hidden"
          >
            <div className="flex-1 overflow-auto">{children}</div>
          </div>
        )}
      </div>
    </CollapsiblePanelProvider>
  )
}
