import { ReactNode, useState, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
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
  const [buttonRenderedByChild, setButtonRenderedByChild] = useState(false)
  const warnedRef = useRef(false)

  // Callback when child renders the CollapseButton
  const handleButtonRendered = () => {
    setButtonRenderedByChild(true)
  }

  // Check if button was rendered after mount, warn in dev if not
  useEffect(() => {
    if (!buttonRenderedByChild && !warnedRef.current && process.env.NODE_ENV === 'development') {
      warnedRef.current = true
      console.warn(
        `CollapsiblePanel (${side}): Toggle button not rendered by children. ` +
        `Consider using useCollapsiblePanel() hook to render <CollapseButton /> in your panel header. ` +
        `Falling back to default floating position.`
      )
    }
  }, [buttonRenderedByChild, side])

  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  const ExpandIcon = side === 'left' ? ChevronRight : ChevronLeft
  // Collapse buttons always on left when expanded; expand buttons on opposite edges when collapsed
  const buttonSideClass = collapsed
    ? (side === 'left' ? 'right-2' : 'left-2')
    : 'left-2'

  const panelLabel = `${side} panel`
  const panelId = `${side}-panel`
  const ariaLabel = collapsed
    ? `Expand ${panelLabel}`
    : `Collapse ${panelLabel}`

  return (
    <CollapsiblePanelProvider
      collapsed={collapsed}
      onToggle={onToggle}
      side={side}
      onButtonRendered={handleButtonRendered}
    >
      <div className={cn('relative flex h-full flex-col', className)}>
        {/* Fallback Collapse Toggle Button (only if child doesn't render it) */}
        {!buttonRenderedByChild && (
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
        )}

        {/* Panel Content */}
        {!collapsed && (
          <div
            id={panelId}
            role="region"
            aria-label={panelLabel}
            className="flex h-full flex-col overflow-hidden"
          >
            <div className="flex-1 overflow-auto">{children}</div>
          </div>
        )}
      </div>
    </CollapsiblePanelProvider>
  )
}
