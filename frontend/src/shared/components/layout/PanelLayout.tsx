"use client"

import { ReactNode, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/shared/components/ui/resizable'
import type { ImperativePanelHandle } from 'react-resizable-panels'

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
  // Always-visible center controls for collapsing/expanding sidebars
  function CenterSideToggle({ side }: { side: 'left' | 'right' }) {
    const isCollapsed = side === 'left' ? leftCollapsed : rightCollapsed
    const onToggle = side === 'left' ? onLeftCollapse : onRightCollapse
    const ariaLabel = isCollapsed ? `Expand ${side} panel` : `Collapse ${side} panel`
    const panelId = `${side}-panel`
    const posClass = side === 'left' ? 'left-2' : 'right-2'

    return (
      <div className={cn('absolute top-2 z-20', posClass)}>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg bg-background/80 shadow-sm ring-1 ring-border"
          onClick={() => onToggle?.()}
          aria-label={ariaLabel}
          aria-controls={panelId}
          aria-expanded={!isCollapsed}
          title={ariaLabel}
        >
          {/* For left: show chevron pointing toward the sidebar when expanding, away when collapsing */}
          {side === 'left'
            ? isCollapsed
              ? <ChevronRight className="h-4 w-4" />
              : <ChevronLeft className="h-4 w-4" />
            : isCollapsed
              ? <ChevronLeft className="h-4 w-4" />
              : <ChevronRight className="h-4 w-4" />}
        </Button>
      </div>
    )
  }

  // Keep three resizable panels consistently mounted and use
  // programmatic collapse/expand to reflect Zustand booleans.
  const leftRef = useRef<ImperativePanelHandle | null>(null)
  const rightRef = useRef<ImperativePanelHandle | null>(null)

  useEffect(() => {
    if (leftCollapsed) leftRef.current?.collapse()
    else leftRef.current?.expand()
  }, [leftCollapsed])

  useEffect(() => {
    if (rightCollapsed) rightRef.current?.collapse()
    else rightRef.current?.expand()
  }, [rightCollapsed])

  return (
    <div className={cn('relative flex h-full w-full overflow-hidden border-x', className)}>
      <ResizablePanelGroup direction="horizontal" autoSaveId="workspace:panels:v1">
        {/* Left Panel */}
        <ResizablePanel
          ref={leftRef}
          collapsible
          collapsedSize={0}
          minSize={12}
          defaultSize={22}
          onCollapse={() => {
            if (!leftCollapsed) onLeftCollapse?.()
          }}
          onExpand={() => {
            if (leftCollapsed) onLeftCollapse?.()
          }}
        >
          {/* When collapsed, CollapsiblePanel hides content; width goes to 0 via collapsedSize. */}
          {!leftCollapsed && left}
        </ResizablePanel>

        <ResizableHandle />

        {/* Center Panel */}
        <ResizablePanel minSize={30} defaultSize={56} className="min-w-0">
          <div
            id="center-panel-layout"
            role="region"
            aria-label="Center panel"
            className="relative h-full overflow-hidden"
          >
            {/* Always-visible toggles live inside the center region */}
            <CenterSideToggle side="left" />
            <CenterSideToggle side="right" />
            {center}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Right Panel */}
        <ResizablePanel
          ref={rightRef}
          collapsible
          collapsedSize={0}
          minSize={16}
          defaultSize={22}
          onCollapse={() => {
            if (!rightCollapsed) onRightCollapse?.()
          }}
          onExpand={() => {
            if (rightCollapsed) onRightCollapse?.()
          }}
        >
          {!rightCollapsed && right}
        </ResizablePanel>
      </ResizablePanelGroup>

    </div>
  )
}
