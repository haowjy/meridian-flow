import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
import type { Thread } from '@/features/threads/types'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/shared/components/ui/context-menu'
import { ThreadTitleMenu } from './ThreadTitleMenu'
import { ThreadTitleEditor } from './ThreadTitleEditor'

interface ThreadListItemProps {
  thread: Thread
  isActive: boolean
  isDisabled?: boolean
  isRenaming?: boolean
  onClick: () => void
  onRename?: () => void
  onRenameSubmit?: (newTitle: string) => void
  onRenameCancel?: () => void
  onDelete?: () => void
}

/**
 * Single thread row.
 *
 * Single responsibility:
 * - Render one thread as a selectable item.
 * - Provide dropdown/context menu for rename and delete actions.
 * - Support inline editing when isRenaming is true.
 *
 * No data fetching; no knowledge of turns/streaming.
 */
export function ThreadListItem({
  thread,
  isActive,
  isDisabled,
  isRenaming,
  onClick,
  onRename,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}: ThreadListItemProps) {
  const handleRenameSubmit = (title: string) => {
    onRenameSubmit?.(title)
  }

  const handleRenameCancel = () => {
    onRenameCancel?.()
  }

  // Context menu items (for right-click)
  const contextMenuItems = (
    <>
      {onRename && (
        <ContextMenuItem onClick={onRename}>
          <Pencil className="size-3.5" />
          Rename
        </ContextMenuItem>
      )}
      {onRename && onDelete && <ContextMenuSeparator />}
      {onDelete && (
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 className="size-3.5" />
          Delete
        </ContextMenuItem>
      )}
    </>
  )

  const itemContent = (
    <div
      role="button"
      tabIndex={isRenaming ? -1 : 0}
      onClick={isRenaming ? undefined : onClick}
      onKeyDown={isRenaming ? undefined : (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={cn(
        'thread-list-item group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm transition-colors',
        'hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
        isActive && 'thread-list-item--active bg-sidebar-accent text-sidebar-accent-foreground',
        isDisabled && 'opacity-60 pointer-events-none'
      )}
    >
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        {isRenaming ? (
          <ThreadTitleEditor
            key={`rename-${thread.id}`}
            initialValue={thread.title || ''}
            onSubmit={handleRenameSubmit}
            onCancel={handleRenameCancel}
            className="text-sm font-medium"
          />
        ) : (
          <span className="truncate font-medium">
            {thread.title || 'Untitled Thread'}
          </span>
        )}
      </div>

      {/* "..." button - visible on hover or when dropdown is open */}
      {!isRenaming && (onRename || onDelete) && (
        <ThreadTitleMenu
          trigger={
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'flex-shrink-0 h-4 w-4 p-0 rounded-sm hover:bg-sidebar-accent transition-opacity',
                'opacity-0 group-hover:opacity-100 focus:opacity-100'
              )}
              aria-label="Thread options"
            >
              <MoreHorizontal className="h-4.5 w-4.5" />
            </Button>
          }
          onRename={onRename}
          onDelete={onDelete}
          align="end"
        />
      )}
    </div>
  )

  // Wrap with context menu for right-click support
  if (onRename || onDelete) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {itemContent}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {contextMenuItems}
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return itemContent
}
