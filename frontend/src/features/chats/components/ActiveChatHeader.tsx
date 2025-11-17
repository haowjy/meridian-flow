"use client"

import type { Chat } from '@/features/chats/types'
import { Button } from '@/shared/components/ui/button'
import { MoreHorizontal } from 'lucide-react'

interface ActiveChatHeaderProps {
  chat: Chat
}

/**
 * Header for the active chat.
 *
 * Single responsibility:
 * - Show chat title + affordances for future actions (rename, menu).
 */
export function ActiveChatHeader({ chat }: ActiveChatHeaderProps) {
  return (
    <div className="chat-main-header">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold">
          {chat.title || 'Untitled Chat'}
        </h2>
      </div>
      <div className="flex items-center gap-1">
        {/* Placeholder for future actions: rename, delete, export */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Chat menu"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

