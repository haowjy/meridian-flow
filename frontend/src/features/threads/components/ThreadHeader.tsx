import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Thread } from '@/features/threads/types'
import {
  useUIStore,
  selectEffectiveLeftCollapsed,
  selectEffectiveRightCollapsed,
} from '@/core/stores/useUIStore'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'
import { ProgressiveBreadcrumb } from './ProgressiveBreadcrumb'

interface ThreadHeaderProps {
  thread?: Thread | null
  onRename?: (title: string) => void
  onDelete?: () => void
}

/**
 * Header for the thread area.
 *
 * Shows thread breadcrumb with navigation controls and optional
 * dropdown menu for rename/delete actions.
 */
export function ThreadHeader({
  thread,
  onRename,
  onDelete,
}: ThreadHeaderProps) {
  const [isRenaming, setIsRenaming] = useState(false)

  const { leftPanelCollapsed, rightPanelCollapsed } = useUIStore(useShallow((s) => ({
    leftPanelCollapsed: selectEffectiveLeftCollapsed(s),
    rightPanelCollapsed: selectEffectiveRightCollapsed(s),
  })))

  const handleRenameSubmit = (title: string) => {
    onRename?.(title)
    setIsRenaming(false)
  }

  const handleRenameCancel = () => {
    setIsRenaming(false)
  }

  const threadTitle = thread?.title || null

  return (
    <div className="flex items-center justify-between px-2 sm:px-3 h-[var(--panel-header-height)]">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* Desktop: Only show if left panel is collapsed */}
        {leftPanelCollapsed && (
          <SidebarToggle side="left" className="shrink-0" />
        )}

        {/* Thread title breadcrumb - single source of truth for view and edit modes */}
        {thread && (
          <ProgressiveBreadcrumb
            threadTitle={threadTitle}
            isEditing={isRenaming}
            onStartEdit={() => setIsRenaming(true)}
            onSubmitEdit={handleRenameSubmit}
            onCancelEdit={handleRenameCancel}
            onRename={onRename ? () => setIsRenaming(true) : undefined}
            onDelete={onDelete}
          />
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* Desktop: Only show if right panel is collapsed */}
        {rightPanelCollapsed && (
          <SidebarToggle side="right" className="shrink-0" />
        )}
      </div>
    </div>
  )
}
