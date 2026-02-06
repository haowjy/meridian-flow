import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Thread } from '@/features/threads/types'
import {
  useUIStore,
  selectEffectiveLeftCollapsed,
  selectEffectiveRightCollapsed,
} from '@/core/stores/useUIStore'
import { PanelHeader } from '@/shared/components/layout/headers'
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

  // Leading: sidebar toggle (when collapsed) + breadcrumb
  const leadingContent = (
    <>
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
    </>
  )

  // Trailing: right sidebar toggle (when collapsed)
  const trailingContent = rightPanelCollapsed ? (
    <SidebarToggle side="right" className="shrink-0" />
  ) : null

  return (
    <PanelHeader
      leading={leadingContent}
      trailing={trailingContent}
      showGradient={false}
      className="px-2 sm:px-3"
    />
  )
}
