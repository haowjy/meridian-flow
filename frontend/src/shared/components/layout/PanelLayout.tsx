import { ReactNode, useEffect, useRef, useState } from 'react'
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
 * Three-panel layout for workspace (Thread List | Active Thread | Documents).
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
  // Keep three resizable panels consistently mounted.
  // Uses bidirectional sync: UIStore ↔ Library via imperative API + callbacks.
  // This is the intended pattern for react-resizable-panels (no declarative collapse prop exists).
  //
  // IMPORTANT: Each panel has explicit `id` and `order` props to stabilize identity
  // across re-renders. Panel sizing uses percentage-based `minSize` only - no CSS minWidth.
  // Mixing CSS constraints with the library's flex-based constraints causes drag bugs.
  // See: https://github.com/bvaughn/react-resizable-panels/issues/142
  const leftRef = useRef<ImperativePanelHandle | null>(null)
  const rightRef = useRef<ImperativePanelHandle | null>(null)
  const isDraggingRef = useRef(false)
  // Track resizing state for conditional animations - only animate when NOT dragging
  // This prevents CSS transitions from interfering with manual drag operations
  const [isResizing, setIsResizing] = useState(false)

  useEffect(() => {
    // Skip imperative calls during active drag to prevent race condition
    if (isDraggingRef.current) return

    if (leftCollapsed) leftRef.current?.collapse()
    else leftRef.current?.expand()
  }, [leftCollapsed])

  useEffect(() => {
    // Skip imperative calls during active drag to prevent race condition
    if (isDraggingRef.current) return

    if (rightCollapsed) rightRef.current?.collapse()
    else rightRef.current?.expand()
  }, [rightCollapsed])

  return (
    <div className={cn('relative flex h-full w-full overflow-hidden', className)}>
      <ResizablePanelGroup direction="horizontal" autoSaveId="workspace:panels:v1">
        {/* Left Panel */}
        <ResizablePanel
          id="workspace-panel-left"
          order={1}
          ref={leftRef}
          className={cn('workspace-panel-left', !isResizing && 'transition-all duration-200 ease-out')}
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
          {left}
        </ResizablePanel>

        <ResizableHandle
          className="after:!bg-sidebar-border"
          onDragging={(isDragging) => {
            isDraggingRef.current = isDragging
            setIsResizing(isDragging)
          }}
        />

        {/* Center Panel */}
        <ResizablePanel id="workspace-panel-center" order={2} minSize={20} defaultSize={56} className="min-w-0">
          <div
            id="center-panel-layout"
            role="region"
            aria-label="Center panel"
            className="relative h-full overflow-hidden"
          >
            {center}
          </div>
        </ResizablePanel>

        <ResizableHandle
          onDragging={(isDragging) => {
            isDraggingRef.current = isDragging
            setIsResizing(isDragging)
          }}
        />

        {/* Right Panel */}
        <ResizablePanel
          id="workspace-panel-right"
          order={3}
          ref={rightRef}
          className={cn('workspace-panel-right', !isResizing && 'transition-all duration-200 ease-out')}
          collapsible
          collapsedSize={0}
          minSize={20}
          defaultSize={22}
          onCollapse={() => {
            if (!rightCollapsed) onRightCollapse?.()
          }}
          onExpand={() => {
            if (rightCollapsed) onRightCollapse?.()
          }}
        >
          {right}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
