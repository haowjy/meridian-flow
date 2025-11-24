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

  const { createChat } = useChatStore(useShallow((s) => ({
    createChat: s.createChat,
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

  const hasChats = chats.length > 0

  const handleBrandClick = () => {
    router.push('/projects')
  }

  return (
    <div className="chat-pane flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <ChatListHeader
        projectId={projectId}
        isLoading={isLoading}
        onNewChat={handleNewChat}
        onBrandClick={handleBrandClick}
      />
      <div className="chat-pane-body flex-1 overflow-hidden">
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
            onSelectChat={handleSelectChat}
          />
        ) : (
          <ChatListEmpty onNewChat={handleNewChat} />
        )}
      </div>
    </div>
  )
}
