import { useState, useRef, useEffect } from 'react'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
import type { Chat } from '@/features/chats/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/shared/components/ui/context-menu'

interface ChatListItemProps {
  chat: Chat
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
 * Single chat row.
 *
 * Single responsibility:
 * - Render one chat as a selectable item.
 * - Provide dropdown/context menu for rename and delete actions.
 * - Support inline editing when isRenaming is true.
 *
 * No data fetching; no knowledge of turns/streaming.
 */
export function ChatListItem({
  chat,
  isActive,
  isDisabled,
  isRenaming,
  onClick,
  onRename,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}: ChatListItemProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  // Focus and select input when entering rename mode
  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isRenaming])

  const handleSubmit = () => {
    const trimmed = inputRef.current?.value.trim() || ''
    if (trimmed && trimmed !== chat.title) {
      onRenameSubmit?.(trimmed)
    } else {
      onRenameCancel?.()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onRenameCancel?.()
    }
  }

  // Shared menu items for both dropdown and context menu
  const menuItems = (
    <>
      <DropdownMenuItem onClick={onRename}>
        <Pencil className="size-3.5" />
        Rename
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 className="size-3.5" />
        Delete
      </DropdownMenuItem>
    </>
  )

  const contextMenuItems = (
    <>
      <ContextMenuItem onClick={onRename}>
        <Pencil className="size-3.5" />
        Rename
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 className="size-3.5" />
        Delete
      </ContextMenuItem>
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
        'chat-list-item group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm transition-colors',
        'hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
        isActive && 'chat-list-item--active bg-sidebar-accent text-sidebar-accent-foreground',
        isDisabled && 'opacity-60 pointer-events-none'
      )}
    >
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        {isRenaming ? (
          <input
            key={`rename-${chat.id}`}
            ref={inputRef}
            type="text"
            defaultValue={chat.title || ''}
            onBlur={handleSubmit}
            onKeyDown={handleKeyDown}
            className="w-full bg-transparent font-medium outline-none border-b border-accent focus:border-accent-foreground"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate font-medium">
            {chat.title || 'Untitled Chat'}
          </span>
        )}
      </div>

      {/* "..." button - visible on hover or when dropdown is open */}
      {!isRenaming && (onRename || onDelete) && (
        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'flex-shrink-0 h-4 w-4 p-0 rounded-sm hover:bg-sidebar-accent transition-opacity',
                'opacity-0 group-hover:opacity-100 focus:opacity-100',
                dropdownOpen && 'opacity-100'
              )}
              aria-label="Chat options"
            >
              <MoreHorizontal className="h-4.5 w-4.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            {menuItems}
          </DropdownMenuContent>
        </DropdownMenu>
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
