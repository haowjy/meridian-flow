import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/core/stores/useUIStore'
import { useTurnsForChat } from '@/features/chats/hooks/useTurnsForChat'
import { useChatStore } from '@/core/stores/useChatStore'
import { useChatSSE } from '@/features/chats/hooks/useChatSSE'
import { Sparkles } from 'lucide-react'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'
import { ChatHeader } from './ChatHeader'
import { TurnList } from './TurnList'
import { TurnInput } from './TurnInput'
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

  const { activeChatId, chatFocusVersion } = useUIStore(useShallow((s) => ({
    activeChatId: s.activeChatId,
    chatFocusVersion: s.chatFocusVersion,
  })))

  const { chats, currentTurnId } = useChatStore(useShallow((s) => ({
    chats: s.chats,
    currentTurnId: s.currentTurnId,
  })))

  const { projectId, projectName } = useProjectStore(useShallow((state) => {
    const currentId = state.currentProjectId
    if (!currentId) return { projectId: null, projectName: null }
    const project = state.projects.find((p) => p.id === currentId)
    return {
      projectId: currentId,
      projectName: project?.name ?? null,
    }
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

  // Cold start: no chat selected but projectId available
  // Uses simpler flex layout without scroll container (no scrolling needed)
  if (!activeChat) {
    return (
      <div className="chat-main">
        {/* Header - not sticky, just at top */}
        <div className="bg-background relative">
          <ChatHeader chat={null} projectName={projectName} />
          <HeaderGradientFade />
        </div>

        {/* Content fills remaining space - flex-1 works because chat-main is flex col */}
        <div className="flex-1 flex flex-col min-w-0 pt-3">
          {/* Welcome centered in available space */}
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <Sparkles className="mx-auto mb-2 size-6" />
              <p>Start a new conversation</p>
            </div>
          </div>

          {/* Input at bottom */}
          <div className="bg-background">
            <TurnInput
              projectId={projectId ?? undefined}
              focusKey={`${activeChatId ?? 'none'}:${chatFocusVersion}`}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-main">
      {/* Single scroll container - scrollbar extends to top */}
      <div className="chat-scroll-container">
        {/* Sticky Header */}
        <div className="sticky top-0 z-10 bg-background relative">
          <ChatHeader chat={activeChat} projectName={projectName} />
          <HeaderGradientFade />
        </div>

        <div className="relative min-h-full min-w-0 flex flex-col pt-3">
          {/* Show skeleton conversation for cold loads (no cached turns) */}
          {isLoading && turns.length === 0 && showSkeleton ? (
            <div className="flex flex-col gap-4 p-4 flex-1">
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
              {/* Messages take remaining space, pushing input to bottom when few messages */}
              <div className="flex-1">
                <TurnList turns={turns} scrollToTurnId={currentTurnId} isLoading={isLoading} />
              </div>
            </>
          )}
          {/* Sticky input at bottom of scroll area */}
          <div className="sticky bottom-0 bg-background">
            <TurnInput
              chatId={activeChat.id}
              focusKey={`${activeChatId ?? 'none'}:${chatFocusVersion}`}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
