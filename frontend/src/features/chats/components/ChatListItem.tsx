'use client'

import { cn } from '@/lib/utils'
import type { Chat } from '@/features/chats/types'

interface ChatListItemProps {
  chat: Chat
  isActive: boolean
  isDisabled?: boolean
  onClick: () => void
}

/**
 * Single chat row.
 *
 * Single responsibility:
 * - Render one chat as a selectable item.
 *
 * No data fetching; no knowledge of turns/streaming.
 */
export function ChatListItem({ chat, isActive, isDisabled, onClick }: ChatListItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      className={cn(
        'chat-list-item group flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm transition-colors',
        'hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
        isActive && 'chat-list-item--active bg-sidebar-accent text-sidebar-accent-foreground',
        isDisabled && 'opacity-60'
      )}
    >
      <div className="flex flex-1 flex-col overflow-hidden">
        <span className="truncate font-medium">
          {chat.title || 'Untitled Chat'}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {/* Placeholder: later we can show relative updatedAt or first turn snippet */}
        </span>
      </div>
    </button>
  )
}
