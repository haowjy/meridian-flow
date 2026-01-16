import { useCallback, useEffect, useRef, useState } from 'react'
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
import { DeleteThreadDialog } from './DeleteThreadDialog'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { useStreamingAutoScroll } from '@/features/threads/hooks/useStreamingAutoScroll'
import { UserMessageSkeleton } from './skeletons/UserMessageSkeleton'
import { AIMessageSkeleton } from './skeletons/AIMessageSkeleton'

/**
 * Measures an element's height via callback ref, only updating state when changed.
 * Prevents unnecessary re-renders that can cause scroll position issues.
 *
 * @param threshold - Minimum height change (in px) to trigger state update.
 *                    Defaults to 2px to ignore micro layout shifts from focus rings,
 *                    sub-pixel rendering differences, etc.
 */
function useElementHeight(threshold = 2) {
  const [height, setHeight] = useState(0)
  const heightRef = useRef(0) // Track current height without causing re-renders

  const ref = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      const measured = node.getBoundingClientRect().height
      // Only update if change exceeds threshold to prevent scroll jumps
      // from micro layout shifts (focus rings, sub-pixel differences)
      if (Math.abs(measured - heightRef.current) > threshold) {
        heightRef.current = measured
        setHeight(measured)
      }
    }
  }, [threshold])

  return [height, ref] as const
}

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
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const { activeThreadId, threadFocusVersion } = useUIStore(useShallow((s) => ({
    activeThreadId: s.activeThreadId,
    threadFocusVersion: s.threadFocusVersion,
  })))

  const { threads, currentTurnId, streamingTurnId, setCurrentTurnId, renameThread, deleteThread } = useThreadStore(useShallow((s) => ({
    threads: s.threads,
    currentTurnId: s.currentTurnId,
    streamingTurnId: s.streamingTurnId,
    setCurrentTurnId: s.setCurrentTurnId,
    renameThread: s.renameThread,
    deleteThread: s.deleteThread,
  })))


  // Callback ref pattern: useState triggers re-render when element is assigned,
  // allowing effects to run with the actual element (useRef doesn't trigger re-renders)
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null)

  // Measure input height for content minHeight calculation.
  // Header height is a CSS variable (--thread-header-height) - no measurement needed.
  const [inputHeight, inputRef] = useElementHeight()

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

  // Handlers for thread actions
  const handleRename = useCallback((title: string) => {
    if (activeThread) {
      void renameThread(activeThread.id, title)
    }
  }, [activeThread, renameThread])

  const handleDeleteConfirm = useCallback(async () => {
    if (activeThread) {
      setIsDeleting(true)
      try {
        await deleteThread(activeThread.id)
        setShowDeleteDialog(false)
      } finally {
        setIsDeleting(false)
      }
    }
  }, [activeThread, deleteThread])

  // Cold start: no thread selected but projectId available
  // Uses sticky header inside scroll container
  if (!activeThread) {
    return (
      <div className="thread-main">
        <div
          className="h-full overflow-y-auto scroll-pt-[var(--thread-header-height)]"
          style={{
            scrollPaddingBottom: `${inputHeight}px`,
            overflowAnchor: 'none', // Disable browser scroll anchoring to prevent scroll jumps during header edits
          }}
        >
          {/* Sticky header at top of scroll container */}
          <div className="sticky top-0 z-10 bg-background">
            <ThreadHeader thread={null} />
            <HeaderGradientFade />
          </div>

          {/* Welcome message centered */}
          <div
            className="flex-1 flex items-center justify-center pt-3"
            style={{ minHeight: `calc(100% - var(--thread-header-height) - ${inputHeight}px)` }}
          >
            <div className="text-center text-muted-foreground">
              <Sparkles className="mx-auto mb-2 size-6" />
              <p>Start a new thread</p>
            </div>
          </div>

          {/* Input at bottom */}
          <div ref={inputRef} className="bg-background">
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
      {/* Single scroll container with everything inside */}
      <div
        ref={setScrollContainer}
        className="h-full overflow-y-auto overflow-x-hidden scroll-pt-[var(--thread-header-height)]"
        style={{
          scrollPaddingBottom: `${inputHeight}px`,
          overflowAnchor: 'none', // Disable browser scroll anchoring to prevent scroll jumps during header edits
        }}
      >
        {/* Sticky header at top of scroll container */}
        <div className="sticky top-0 z-10 bg-background">
          <ThreadHeader
            thread={activeThread}
            onRename={handleRename}
            onDelete={() => setShowDeleteDialog(true)}
          />
          <HeaderGradientFade />
        </div>

        {/* Content wrapper - calc-based min-height accounts for header and input */}
        <div
          className="relative min-w-0 flex flex-col pt-3"
          style={{
            minHeight: `calc(100% - var(--thread-header-height) - ${inputHeight}px)`,
          }}
        >
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
              {/* Messages take remaining space */}
              <div className="flex-1">
                <TurnList turns={turns} scrollToTurnId={currentTurnId} isLoading={isLoading} />
              </div>
            </>
          )}
        </div>

        {/* Sticky input at bottom of scroll container */}
        <div ref={inputRef} className="sticky bottom-0 bg-background relative">
          {/* Floating scroll-to-bottom button - positioned above input */}
          <ScrollToBottomButton visible={showScrollButton} onClick={scrollToBottom} />
          <TurnInput
            threadId={activeThread.id}
            focusKey={`${activeThreadId ?? 'none'}:${threadFocusVersion}`}
          />
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <DeleteThreadDialog
        thread={activeThread}
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={handleDeleteConfirm}
        isDeleting={isDeleting}
      />
    </div>
  )
}
