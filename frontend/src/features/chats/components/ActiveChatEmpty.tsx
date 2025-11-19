"use client"

import { MessageSquare } from 'lucide-react'

/**
 * Empty state for the center panel when no chat is selected.
 */
export function ActiveChatEmpty() {
  return (
    <div className="chat-main-empty">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground">
        <MessageSquare className="size-5" />
      </div>
      <p className="mb-1 font-medium">
        No chat selected
      </p>
      <p className="max-w-[260px]">
        Choose a chat from the left panel to view the conversation, or create a new chat to start writing.
      </p>
    </div>
  )
}

