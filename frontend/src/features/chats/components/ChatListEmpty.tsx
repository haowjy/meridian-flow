'use client'

import { MessageCircle } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'

interface ChatListEmptyProps {
  onNewChat: () => void
}

/**
 * Empty state for the chat list.
 *
 * Single responsibility:
 * - Explain that there are no chats yet and offer a clear call to action.
 */
export function ChatListEmpty({ onNewChat }: ChatListEmptyProps) {
  return (
    <div className="chat-pane-empty flex h-full flex-col items-center justify-center px-4 text-center text-xs text-muted-foreground">
      <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-muted text-foreground">
        <MessageCircle className="h-4 w-4" />
      </div>
      <p className="mb-1 font-medium text-foreground">
        Start a conversation
      </p>
      <p className="mb-3 max-w-[220px]">
        Create a chat to brainstorm ideas, outline chapters, or ask questions about your project.
      </p>
      <Button size="sm" onClick={onNewChat}>
        New Chat
      </Button>
    </div>
  )
}

