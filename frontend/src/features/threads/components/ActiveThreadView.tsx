import { useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/core/stores/useUIStore'
import { useTurnsForThread } from '@/features/threads/hooks/useTurnsForThread'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useThreadSSE } from '@/features/threads/hooks/useThreadSSE'
import { Sparkles } from 'lucide-react'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'
import { ThreadHeader } from './ThreadHeader'
import { TurnList } from './TurnList'
import { TurnInput } from './TurnInput'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { useStreamingAutoScroll } from '@/features/threads/hooks/useStreamingAutoScroll'
import { UserMessageSkeleton } from './skeletons/UserMessageSkeleton'
import { AIMessageSkeleton } from './skeletons/AIMessageSkeleton'
import { useProjectStore } from '@/core/stores/useProjectStore'

interface ActiveThreadViewProps {
  /** Project ID passed directly from route - avoids async store race condition */
  projectId: string
}

/**
 * Center panel thread view.
 *
 * Responsibilities:
 * - Read activeThreadId from UI store
 * - Select the corresponding Thread from useThreadStore
 * - Render header, turn/message list, and input
 *
 * It does NOT:
 * - Know how threads are loaded (left panel concern)
 * - Contain SSE/EventSource details (delegated to useThreadSSE)
 */
export function ActiveThreadView({ projectId }: ActiveThreadViewProps) {
  const [showSkeleton, setShowSkeleton] = useState(false)

  const { activeThreadId, threadFocusVersion } = useUIStore(useShallow((s) => ({
    activeThreadId: s.activeThreadId,
    threadFocusVersion: s.threadFocusVersion,
  })))

  const { threads, currentTurnId, streamingTurnId, setCurrentTurnId } = useThreadStore(useShallow((s) => ({
    threads: s.threads,
    currentTurnId: s.currentTurnId,
    streamingTurnId: s.streamingTurnId,
    setCurrentTurnId: s.setCurrentTurnId,
  })))

  // Only need projectName for display - projectId comes from prop (avoids async race)
  const projectName = useProjectStore((state) => {
    const project = state.projects.find((p) => p.id === projectId)
    return project?.name ?? null
  })

  // Callback ref pattern: useState triggers re-render when element is assigned,
  // allowing effects to run with the actual element (useRef doesn't trigger re-renders)
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null)

  // Always call hooks unconditionally to respect Rules of Hooks.
  useThreadSSE()
  const { turns, isLoading } = useTurnsForThread(activeThreadId)

  // Callback to update currentTurnId when scrolling to bottom
  const handleScrollToBottom = useCallback(() => {
    const latestTurn = turns[turns.length - 1]
    if (latestTurn) {
      setCurrentTurnId(latestTurn.id)
    }
  }, [turns, setCurrentTurnId])

  // Auto-scroll management during streaming
  const { showScrollButton, scrollToBottom } = useStreamingAutoScroll({
    scrollContainer,
    isStreaming: streamingTurnId !== null,
    onScrollToBottom: handleScrollToBottom,
  })

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

  const activeThread = threads.find((t) => t.id === activeThreadId) || null

  // Cold start: no thread selected but projectId available
  // Uses simpler flex layout without scroll container (no scrolling needed)
  if (!activeThread) {
    return (
      <div className="thread-main">
        {/* Header - not sticky, just at top */}
        <div className="bg-background relative">
          <ThreadHeader thread={null} projectName={projectName} />
          <HeaderGradientFade />
        </div>

        {/* Content fills remaining space - flex-1 works because thread-main is flex col */}
        <div className="flex-1 flex flex-col min-w-0 pt-3">
          {/* Welcome centered in available space */}
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <Sparkles className="mx-auto mb-2 size-6" />
              <p>Start a new thread</p>
            </div>
          </div>

          {/* Input at bottom */}
          <div className="bg-background">
            <TurnInput
              projectId={projectId}
              focusKey={`${activeThreadId ?? 'none'}:${threadFocusVersion}`}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="thread-main">
      {/* Single scroll container - scrollbar extends to top */}
      <div ref={setScrollContainer} className="thread-scroll-container">
        {/* Sticky Header */}
        <div className="sticky top-0 z-10 bg-background relative">
          <ThreadHeader thread={activeThread} projectName={projectName} />
          <HeaderGradientFade />
        </div>

        <div className="relative min-h-full min-w-0 flex flex-col pt-3">
          {/* Show skeleton thread for cold loads (no cached turns) */}
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
          <div className="sticky bottom-0 bg-background relative">
            {/* Floating scroll-to-bottom button - positioned above input */}
            <ScrollToBottomButton visible={showScrollButton} onClick={scrollToBottom} />
            <TurnInput
              threadId={activeThread.id}
              focusKey={`${activeThreadId ?? 'none'}:${threadFocusVersion}`}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
