import { ScrollArea } from '@/shared/components/ui/scroll-area'
import type { Chat } from '@/features/chats/types'
import { ChatListItem } from './ChatListItem'

interface ChatListProps {
  chats: Chat[]
  activeChatId: string | null
  isLoading: boolean
  renamingChatId: string | null
  onSelectChat: (chatId: string) => void
  onRename: (chatId: string) => void
  onRenameSubmit: (chatId: string, newTitle: string) => void
  onRenameCancel: () => void
  onDelete: (chat: Chat) => void
}

/**
 * Pure list container for chats.
 *
 * Responsibilities:
 * - Layout, scrolling, and mapping chats → ChatListItem.
 * - No data fetching or side effects.
 */
export function ChatList({
  chats,
  activeChatId,
  isLoading,
  renamingChatId,
  onSelectChat,
  onRename,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}: ChatListProps) {
  return (
    <ScrollArea className="chat-pane-scroll h-full">
      <div className="flex flex-col gap-1 p-1">
        {chats.map((chat) => (
          <ChatListItem
            key={chat.id}
            chat={chat}
            isActive={chat.id === activeChatId}
            isDisabled={isLoading}
            isRenaming={chat.id === renamingChatId}
            onClick={() => onSelectChat(chat.id)}
            onRename={() => onRename(chat.id)}
            onRenameSubmit={(newTitle) => onRenameSubmit(chat.id, newTitle)}
            onRenameCancel={onRenameCancel}
            onDelete={() => onDelete(chat)}
          />
        ))}
      </div>
    </ScrollArea>
  )
}

