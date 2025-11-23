"use client"

import { ReactNode, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
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
    <div className={cn('relative flex h-full w-full overflow-hidden', className)}>
      <ResizablePanelGroup direction="horizontal" autoSaveId="workspace:panels:v1">
        {/* Left Panel */}
        <ResizablePanel
          ref={leftRef}
          className="workspace-panel-left"
          // IMPORTANT:
          // - When expanded, enforce a minimum pixel width so the chat list
          //   never becomes unusably narrow.
          // - When collapsed, remove the minWidth constraint so the panel
          //   can truly shrink to `collapsedSize={0}`.
          //   Otherwise the CSS min-width would keep reserving space and
          //   leave an empty slab on the left while “collapsed”.
          style={{ minWidth: leftCollapsed ? 0 : 250 }}
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

        <ResizableHandle className="after:!bg-sidebar-border" />

        {/* Center Panel */}
        <ResizablePanel minSize={30} defaultSize={56} className="min-w-0">
          <div
            id="center-panel-layout"
            role="region"
            aria-label="Center panel"
            className="relative h-full overflow-hidden"
          >
            {center}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Right Panel */}
        <ResizablePanel
          ref={rightRef}
          className="workspace-panel-right"
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
