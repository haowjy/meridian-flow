import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Thread } from '@/features/threads/types'
import { useUIStore } from '@/core/stores/useUIStore'
import { Button } from '@/shared/components/ui/button'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'
import { MobileNavButton } from '@/shared/components/layout/MobileNavButton'
import { ThreadBreadcrumb } from './ThreadBreadcrumb'
import { ThreadTitleMenu } from './ThreadTitleMenu'
import { ThreadTitleEditor } from './ThreadTitleEditor'

interface ThreadHeaderProps {
  thread?: Thread | null
  projectName?: string | null
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
  projectName,
  onRename,
  onDelete,
}: ThreadHeaderProps) {
  const [isRenaming, setIsRenaming] = useState(false)

  const { leftPanelCollapsed, rightPanelCollapsed, setMobileActivePanel } = useUIStore(useShallow((s) => ({
    leftPanelCollapsed: s.leftPanelCollapsed,
    rightPanelCollapsed: s.rightPanelCollapsed,
    setMobileActivePanel: s.setMobileActivePanel,
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
    <div className="thread-main-header h-10 px-2 sm:h-12 sm:px-3 flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* Mobile: Navigate to Thread List */}
        <MobileNavButton
          icon="threads"
          onClick={() => setMobileActivePanel('threadList')}
        />

        {/* Desktop: Only show if left panel is collapsed */}
        {leftPanelCollapsed && (
          <SidebarToggle side="left" className="shrink-0" />
        )}

        <div className="min-w-0 flex-1 flex items-center gap-1">
          {isRenaming && thread ? (
            <ThreadTitleEditor
              initialValue={thread.title}
              onSubmit={handleRenameSubmit}
              onCancel={handleRenameCancel}
              className="text-sm"
            />
          ) : (
            <>
              <ThreadBreadcrumb projectName={projectName} threadTitle={threadTitle} />
              {thread && (onRename || onDelete) && (
                <ThreadTitleMenu
                  trigger={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0"
                      aria-label="Thread options"
                    >
                      <ChevronDown className="size-3" />
                    </Button>
                  }
                  onRename={onRename ? () => setIsRenaming(true) : undefined}
                  onDelete={onDelete}
                  align="start"
                />
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* Mobile: Navigate to Document panel */}
        <MobileNavButton
          icon="document"
          onClick={() => setMobileActivePanel('document')}
        />

        {/* Desktop: Only show if right panel is collapsed */}
        {rightPanelCollapsed && (
          <SidebarToggle side="right" className="shrink-0" />
        )}
      </div>
    </div>
  )
}
