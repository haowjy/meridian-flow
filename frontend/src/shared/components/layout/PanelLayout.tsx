import { ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'

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

  function ExpandHandle({
    side,
    title,
    onClick,
  }: {
    side: 'left' | 'right'
    title: string
    onClick: () => void
  }) {
    const [dimmed, setDimmed] = useState(false)
    const timerRef = useRef<NodeJS.Timeout | null>(null)

    useEffect(() => {
      timerRef.current = setTimeout(() => setDimmed(true), 2000)
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current)
      }
    }, [])

    const restartIdle = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setDimmed(true), 2000)
    }

    const handleEnter = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      setDimmed(false)
    }
    const handleLeave = () => restartIdle()

    const posClass = side === 'left' ? 'left-2' : 'right-2'
    const panelId = `${side}-panel-layout`

    return (
      <div className={cn('pointer-events-none absolute top-2 z-20', posClass)}>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'pointer-events-auto h-8 w-8 rounded-lg bg-background/80 shadow-sm ring-1 ring-border transition-opacity',
            dimmed ? 'opacity-60' : 'opacity-100'
          )}
          onClick={onClick}
          aria-label={title}
          aria-expanded={false}
          aria-controls={panelId}
          title={title}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          onFocus={handleEnter}
          onBlur={handleLeave}
        >
          {side === 'left' ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </Button>
      </div>
    )
  }

  return (
    <div className={cn('relative flex h-full w-full overflow-hidden', className)}>
      {/* Left Panel (25% or collapsed) */}
      <div
        id="left-panel-layout"
        role="region"
        aria-label="Left panel"
        className={cn(
          'flex-shrink-0 border-r transition-all duration-300',
          leftCollapsed ? 'w-0' : 'w-1/4'
        )}
      >
        {!leftCollapsed && left}
      </div>

      {/* Center Panel (50% or expanded if sides collapsed) */}
      <div
        id="center-panel-layout"
        role="region"
        aria-label="Center panel"
        className="flex-1 overflow-hidden"
      >
        {center}
      </div>

      {/* Right Panel (25% or collapsed) */}
      <div
        id="right-panel-layout"
        role="region"
        aria-label="Right panel"
        className={cn(
          'flex-shrink-0 border-l transition-all duration-300',
          rightCollapsed ? 'w-0' : 'w-1/4'
        )}
      >
        {!rightCollapsed && right}
      </div>

      {/* Expand handles when collapsed */}
      {leftCollapsed && onLeftCollapse && (
        <ExpandHandle side="left" title="Expand left panel" onClick={onLeftCollapse} />
      )}
      {rightCollapsed && onRightCollapse && (
        <ExpandHandle side="right" title="Expand right panel" onClick={onRightCollapse} />
      )}
    </div>
  )
}
