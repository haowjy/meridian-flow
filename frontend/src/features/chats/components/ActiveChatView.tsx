"use client"

import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/core/stores/useUIStore'
import { useTurnsForChat } from '@/features/chats/hooks/useTurnsForChat'
import { useChatStore } from '@/core/stores/useChatStore'
import { useChatSSE } from '@/features/chats/hooks/useChatSSE'
import { ChatHeader } from './ChatHeader'
import { TurnList } from './TurnList'
import { TurnInput } from './TurnInput'
import { ActiveChatEmpty } from './ActiveChatEmpty'
import { UserMessageSkeleton } from './skeletons/UserMessageSkeleton'
import { AIMessageSkeleton } from './skeletons/AIMessageSkeleton'
import { useProjectStore } from '@/core/stores/useProjectStore'

/**
 * Center panel chat view.
 *
 * Responsibilities:
 * - Read activeChatId from UI store
 * - Select the corresponding Chat from useChatStore
 * - Render header, turn/message list, and input
 *
 * It does NOT:
 * - Know how chats are loaded (left panel concern)
 * - Contain SSE/EventSource details (delegated to useChatSSE)
 */
export function ActiveChatView() {
  const [showSkeleton, setShowSkeleton] = useState(false)

  const { activeChatId } = useUIStore(useShallow((s) => ({
    activeChatId: s.activeChatId,
  })))

  const { chats, currentTurnId } = useChatStore(useShallow((s) => ({
    chats: s.chats,
    currentTurnId: s.currentTurnId,
  })))

  const projectName = useProjectStore(useShallow((state) => {
    const currentId = state.currentProjectId
    if (!currentId) return null
    const project = state.projects.find((p) => p.id === currentId)
    return project?.name ?? null
  }))

  // Always call hooks unconditionally to respect Rules of Hooks.
  useChatSSE()
  const { turns, isLoading } = useTurnsForChat(activeChatId)

  // Skeleton delay: only show skeleton after 150ms if still loading with no turns
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null

    if (isLoading && turns.length === 0) {
      timer = setTimeout(() => setShowSkeleton(true), 150)
    }

    return () => {
      if (timer) clearTimeout(timer)
      setShowSkeleton(false)
    }
  }, [isLoading, turns.length])

  const activeChat = chats.find((c) => c.id === activeChatId) || null

  if (!activeChat) {
    return (
      <div className="chat-main">
        <ChatHeader chat={null} projectName={projectName} />
        <div className="chat-main-body">
          <ActiveChatEmpty />
        </div>
      </div>
    )
  }

  return (
    <div className="chat-main">
      <ChatHeader chat={activeChat} projectName={projectName} />
      <div className="chat-main-body">
        <div className="relative h-full">
          {/* Show skeleton conversation for cold loads (no cached turns) */}
          {isLoading && turns.length === 0 && showSkeleton ? (
            <div className="flex flex-col gap-4 p-4">
              <UserMessageSkeleton />
              <AIMessageSkeleton />
            </div>
          ) : (
            <>
              {/* Show minimal loading badge when paginating/refreshing with existing turns */}
              {isLoading && turns.length > 0 && (
                <div className="absolute inset-x-0 top-2 z-10 mx-auto w-max rounded border bg-popover px-2 py-1 text-xs text-popover-foreground">
                  Loading…
                </div>
              )}
              <TurnList turns={turns} scrollToTurnId={currentTurnId} isLoading={isLoading} />
            </>
          )}
        </div>
      </div>
      <TurnInput chatId={activeChat.id} />
    </div>
  )
}
