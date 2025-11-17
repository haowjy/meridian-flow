'use client'

import { ScrollArea } from '@/shared/components/ui/scroll-area'
import type { Chat } from '@/features/chats/types'
import { ChatListItem } from './ChatListItem'

interface ChatListProps {
  chats: Chat[]
  activeChatId: string | null
  isLoading: boolean
  onSelectChat: (chatId: string) => void
}

/**
 * Pure list container for chats.
 *
 * Responsibilities:
 * - Layout, scrolling, and mapping chats → ChatListItem.
 * - No data fetching or side effects.
 */
export function ChatList({ chats, activeChatId, isLoading, onSelectChat }: ChatListProps) {
  return (
    <ScrollArea className="chat-pane-scroll h-full">
      <div className="flex flex-col gap-1 p-1">
        {chats.map((chat) => (
          <ChatListItem
            key={chat.id}
            chat={chat}
            isActive={chat.id === activeChatId}
            isDisabled={isLoading}
            onClick={() => onSelectChat(chat.id)}
          />
        ))}
      </div>
    </ScrollArea>
  )
}

