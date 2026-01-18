import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/core/stores/useUIStore'
import { useTurnsForThread } from '@/features/threads/hooks/useTurnsForThread'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useThreadSSE } from '@/features/threads/hooks/useThreadSSE'
import { useLoadingView } from '@/core/hooks'
import { Sparkles } from 'lucide-react'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'
import { ThreadHeader } from './ThreadHeader'
import { TurnList } from './TurnList'
import { TurnInput } from './TurnInput'
import { DeleteThreadDialog } from './DeleteThreadDialog'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { useStreamingAutoScroll } from '@/features/threads/hooks/useStreamingAutoScroll'

const DEBUG_SCROLL = import.meta.env.VITE_DEBUG_SCROLL === '1'

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
  // Content ready = TurnList has rendered, layout is stable, and scroll is complete
  // Until ready, keep TurnList invisible (blank screen during load)
  const [isContentReady, setIsContentReady] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const { activeThreadId, threadFocusVersion } = useUIStore(useShallow((s) => ({
    activeThreadId: s.activeThreadId,
    threadFocusVersion: s.threadFocusVersion,
  })))

  const { threads, statusThreads, currentTurnId, streamingTurnId, setCurrentTurnId, renameThread, deleteThread } = useThreadStore(useShallow((s) => ({
    threads: s.threads,
    statusThreads: s.statusThreads,
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
  // Suppress scroll button during initial load (before content is ready)
  const { showScrollButton: rawShowScrollButton, scrollToBottom } = useStreamingAutoScroll({
    scrollContainer,
    isStreaming: streamingTurnId !== null,
    onScrollToBottom: handleScrollToBottom,
  })
  const showScrollButton = rawShowScrollButton && isContentReady

  // Reset content ready state when thread changes
  useEffect(() => {
    setIsContentReady(false)
  }, [activeThreadId])

  useEffect(() => {
    if (!DEBUG_SCROLL || !scrollContainer) return

    const readMetrics = () => {
      const scrollTop = scrollContainer.scrollTop
      const scrollHeight = scrollContainer.scrollHeight
      const clientHeight = scrollContainer.clientHeight
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      return { scrollTop, scrollHeight, clientHeight, distanceFromBottom }
    }

    let lastLogAt = 0
    const onScroll = () => {
      const now = Date.now()
      if (now - lastLogAt < 200) return
      lastLogAt = now
      console.debug('[scroll] ActiveThreadView:scroll', { t: now, ...readMetrics() })
    }

    console.debug('[scroll] ActiveThreadView:attach', { t: Date.now(), ...readMetrics() })
    scrollContainer.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scrollContainer.removeEventListener('scroll', onScroll)
      console.debug('[scroll] ActiveThreadView:detach', { t: Date.now() })
    }
  }, [scrollContainer])

  useEffect(() => {
    if (!DEBUG_SCROLL || !scrollContainer) return
    console.debug('[scroll] ActiveThreadView:streamingTurnId', {
      t: Date.now(),
      streamingTurnId,
      scrollTop: scrollContainer.scrollTop,
      scrollHeight: scrollContainer.scrollHeight,
      clientHeight: scrollContainer.clientHeight,
    })
  }, [streamingTurnId, scrollContainer])

  // Callback when TurnList has scrolled to position - reveal content
  const handleScrollComplete = useCallback(() => {
    setIsContentReady(true)
  }, [])

  const activeThread = threads.find((t) => t.id === activeThreadId) || null

  // Derive whether to show skeleton or empty state during cold start
  // (when threads are loading, show skeleton; when loaded with no thread, show empty state)
  const coldStartView = useLoadingView({ status: statusThreads, hasData: !!activeThread })

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
  if (!activeThread) {
    // Show empty area + input while threads are loading (sidebars are collapsed)
    // This provides a cleaner initial load without jarring skeleton UI
    if (coldStartView === 'skeleton') {
      return (
        <div className="thread-main">
          <div
            className="h-full overflow-y-auto scroll-pt-[var(--thread-header-height)]"
            style={{
              scrollPaddingBottom: `${inputHeight}px`,
              overflowAnchor: 'none',
            }}
          >
            <div className="sticky top-0 z-10 bg-background">
              <ThreadHeader thread={null} />
              <HeaderGradientFade />
            </div>
            {/* Empty content area - user sees calm empty space during load */}
            <div
              className="flex-1"
              style={{ minHeight: `calc(100% - var(--thread-header-height) - ${inputHeight}px)` }}
            />
            {/* Input ready at bottom for immediate use */}
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

    // Empty state - threads loaded, none selected
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
        data-thread-scroll-container="1"
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
          {/* Show minimal loading badge when paginating/refreshing with existing turns */}
          {isLoading && turns.length > 0 && (
            <div className="absolute inset-x-0 top-2 z-10 mx-auto w-max rounded border bg-popover px-2 py-1 text-xs text-popover-foreground">
              Loading…
            </div>
          )}

          {/* TurnList always renders (allows layout to stabilize and scroll to happen invisibly).
              Made invisible until scroll completes, then revealed. */}
          <div className={`flex-1 ${isContentReady ? '' : 'opacity-0 pointer-events-none'}`}>
            <TurnList
              turns={turns}
              scrollToTurnId={currentTurnId}
              isLoading={isLoading}
              onScrollComplete={handleScrollComplete}
            />
          </div>

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
