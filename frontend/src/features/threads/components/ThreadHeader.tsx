import type { Thread } from '@/features/threads/types'
import { Button } from '@/shared/components/ui/button'
import { MoreHorizontal } from 'lucide-react'
import { ThreadBreadcrumb } from './ThreadBreadcrumb'

import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/core/stores/useUIStore'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'

interface ThreadHeaderProps {
  thread?: Thread | null
  projectName?: string | null
}

/**
 * Header for the thread area.
 *
 * Single responsibility:
 * - Show thread title + affordances for future actions (rename, menu).
 */
export function ThreadHeader({ thread, projectName }: ThreadHeaderProps) {
  const threadTitle = thread?.title || null

  const { leftPanelCollapsed, rightPanelCollapsed } = useUIStore(useShallow((s) => ({
    leftPanelCollapsed: s.leftPanelCollapsed,
    rightPanelCollapsed: s.rightPanelCollapsed,
  })))

  return (
    <div className="thread-main-header h-10 px-2 sm:h-12 sm:px-3 flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* Left Toggle: Only show if left panel is collapsed */}
        {leftPanelCollapsed && (
          <SidebarToggle side="left" className="shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <ThreadBreadcrumb projectName={projectName} threadTitle={threadTitle} />
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* Placeholder for future actions: rename, delete, export */}
        {thread && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 sm:h-7 sm:w-7"
            aria-label="Thread menu"
          >
            <MoreHorizontal className="size-3" />
          </Button>
        )}

        {/* Right Toggle: Only show if right panel is collapsed */}
        {rightPanelCollapsed && (
          <SidebarToggle side="right" className="shrink-0" />
        )}
      </div>
    </div>
  )
}
