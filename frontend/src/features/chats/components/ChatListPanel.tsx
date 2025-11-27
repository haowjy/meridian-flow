'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@/core/stores/useChatStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useChatsForProject } from '@/features/chats/hooks/useChatsForProject'
import { ChatListHeader } from './ChatListHeader'
import { ChatList } from './ChatList'
import { ChatListEmpty } from './ChatListEmpty'
import { ChatListItemSkeleton } from './ChatListItemSkeleton'
import { DeleteChatDialog } from './DeleteChatDialog'
import type { Chat } from '@/features/chats/types'

interface ChatListPanelProps {
  projectId: string
}

/**
 * Left-pane chat panel.
 *
 * Responsibilities (single):
 * - Orchestrate chat list data + selection for the left sidebar.
 *
 * It does NOT:
 * - Know about turn/streaming details (center panel concern).
 * - Render chat contents (delegated to ActiveChatView).
 */
export function ChatListPanel({ projectId }: ChatListPanelProps) {
  const router = useRouter()
  const { chats, status, isLoading } = useChatsForProject(projectId)
  const [showSkeleton, setShowSkeleton] = useState(false)

  // State for delete dialog and rename mode
  const [chatToDelete, setChatToDelete] = useState<Chat | null>(null)
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const { createChat, deleteChat, renameChat } = useChatStore(useShallow((s) => ({
    createChat: s.createChat,
    deleteChat: s.deleteChat,
    renameChat: s.renameChat,
  })))

  const { activeChatId, setActiveChat } = useUIStore(useShallow((s) => ({
    activeChatId: s.activeChatId,
    setActiveChat: s.setActiveChat,
  })))

  // Skeleton delay: only show skeleton after 150ms if still loading
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null

    if (status === 'loading') {
      timer = setTimeout(() => setShowSkeleton(true), 150)
    }

    return () => {
      if (timer) clearTimeout(timer)
      setShowSkeleton(false)
    }
  }, [status])

  const handleNewChat = async () => {
    // MVP: generic title; later we can use first user turn text or auto-titling
    const chat = await createChat(projectId, 'New Chat')
    setActiveChat(chat.id)
  }

  const handleSelectChat = (chatId: string) => {
    setActiveChat(chatId)
    // Actual turns/streaming load lives in center/ActiveChatView, not here.
  }

  // Rename handlers
  const handleRename = (chatId: string) => {
    setRenamingChatId(chatId)
  }

  const handleRenameSubmit = async (chatId: string, newTitle: string) => {
    try {
      await renameChat(chatId, newTitle)
    } finally {
      setRenamingChatId(null)
    }
  }

  const handleRenameCancel = () => {
    setRenamingChatId(null)
  }

  // Delete handlers
  const handleDeleteClick = (chat: Chat) => {
    setChatToDelete(chat)
  }

  const handleDeleteConfirm = async () => {
    if (!chatToDelete) return

    setIsDeleting(true)
    try {
      await deleteChat(chatToDelete.id)
      // If we deleted the active chat, clear the selection
      if (activeChatId === chatToDelete.id) {
        setActiveChat(null)
      }
      setChatToDelete(null)
    } finally {
      setIsDeleting(false)
    }
  }

  const hasChats = chats.length > 0

  const handleBrandClick = () => {
    router.push('/projects')
  }

  return (
    <div className="chat-pane flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Single scroll container - scrollbar extends to top */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        {/* Sticky Header */}
        <div className="sticky top-0 z-10 bg-sidebar relative">
          <ChatListHeader
            projectId={projectId}
            isLoading={isLoading}
            onNewChat={handleNewChat}
            onBrandClick={handleBrandClick}
          />
          {/* Gradient blur fade - extends below the header */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3 translate-y-full bg-gradient-to-b from-sidebar via-sidebar/50 to-transparent" />
        </div>

        {/* Chat List Content */}
        <div className="chat-pane-body pt-3">
          {/* Show skeleton only for true cold loads (no cached chats) */}
          {status === 'loading' && showSkeleton ? (
            <div className="chat-pane-scroll p-2 space-y-1">
              <ChatListItemSkeleton />
              <ChatListItemSkeleton />
              <ChatListItemSkeleton />
            </div>
          ) : hasChats ? (
            <ChatList
              chats={chats}
              activeChatId={activeChatId}
              isLoading={isLoading}
              renamingChatId={renamingChatId}
              onSelectChat={handleSelectChat}
              onRename={handleRename}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
              onDelete={handleDeleteClick}
            />
          ) : (
            <ChatListEmpty onNewChat={handleNewChat} />
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <DeleteChatDialog
        chat={chatToDelete}
        open={chatToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setChatToDelete(null)
        }}
        onConfirm={handleDeleteConfirm}
        isDeleting={isDeleting}
      />
    </div>
  )
}
