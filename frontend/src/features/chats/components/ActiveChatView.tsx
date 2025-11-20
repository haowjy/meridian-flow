"use client"

import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/core/stores/useUIStore'
import { useTurnsForChat } from '@/features/chats/hooks/useTurnsForChat'
import { useChatStore } from '@/core/stores/useChatStore'
import { ChatHeader } from './ChatHeader'
import { TurnList } from './TurnList'
import { TurnInput } from './TurnInput'
import { ActiveChatEmpty } from './ActiveChatEmpty'
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
 * - Implement streaming or SSE (future step)
 */
export function ActiveChatView() {
  const { activeChatId } = useUIStore(useShallow((s) => ({
    activeChatId: s.activeChatId,
  })))

  const { chats } = useChatStore(useShallow((s) => ({
    chats: s.chats,
  })))

  const projectName = useProjectStore(useShallow((state) => {
    const currentId = state.currentProjectId
    if (!currentId) return null
    const project = state.projects.find((p) => p.id === currentId)
    return project?.name ?? null
  }))

  // Always call hooks unconditionally to respect Rules of Hooks.
  const { turns, isLoading } = useTurnsForChat(activeChatId)

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
          {isLoading && (
            <div className="absolute inset-x-0 top-2 z-10 mx-auto w-max rounded border bg-popover px-2 py-1 text-xs text-popover-foreground">
              Loading…
            </div>
          )}
          <TurnList turns={turns} />
        </div>
      </div>
      <TurnInput chatId={activeChat.id} />
    </div>
  )
}
