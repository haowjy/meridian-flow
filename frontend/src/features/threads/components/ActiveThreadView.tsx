import { useCallback, useEffect, useState } from 'react'
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
import { useChatScroller } from '@/features/threads/hooks/useChatScroller'

const DEBUG_SCROLL = import.meta.env.VITE_DEBUG_SCROLL === '1'

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
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  // Dynamic composer height for scroll padding - avoids static 240px gap
  const [composerHeight, setComposerHeight] = useState(100)

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

  // Always call hooks unconditionally to respect Rules of Hooks.
  useThreadSSE()
  const { turnIds, isLoading } = useTurnsForThread(activeThreadId)

  // Callback to update currentTurnId when scrolling to bottom
  const handleScrollToBottom = useCallback(() => {
    const latestTurnId = turnIds[turnIds.length - 1]
    if (latestTurnId) {
      setCurrentTurnId(latestTurnId)
    }
  }, [turnIds, setCurrentTurnId])

  // Simplified scroll controller - fixed-height composer eliminates need for height measurement
  const { isContentReady, showScrollButton, scrollToBottom, listRef } = useChatScroller({
    threadResetKey: activeThreadId, // Only thread changes trigger content gating
    scrollContainer,
    turnIds,
    scrollToTurnId: currentTurnId ?? undefined,
    isLoading,
    isStreaming: streamingTurnId !== null,
    onScrollToBottom: handleScrollToBottom,
  })

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
          <div className="h-full overflow-y-auto scroll-pt-[var(--panel-header-height)]">
            <div className="sticky top-0 z-10 bg-background">
              <ThreadHeader thread={null} />
              <HeaderGradientFade />
            </div>
            {/* Empty content area - user sees calm empty space during load */}
            <div
              className="flex-1"
              style={{
                minHeight: 'calc(100% - var(--panel-header-height))',
                paddingBottom: composerHeight + 16,
              }}
            />
          </div>
          {/* Input ready at bottom for immediate use */}
          <div className="absolute bottom-0 inset-x-0 z-20">
            <TurnInput
              projectId={projectId}
              focusKey={`${activeThreadId ?? 'none'}:${threadFocusVersion}`}
              onHeightChange={setComposerHeight}
            />
          </div>
        </div>
      )
    }

    // Empty state - threads loaded, none selected
    return (
      <div className="thread-main">
        <div className="h-full overflow-y-auto scroll-pt-[var(--panel-header-height)]">
          {/* Sticky header at top of scroll container */}
          <div className="sticky top-0 z-10 bg-background">
            <ThreadHeader thread={null} />
            <HeaderGradientFade />
          </div>

          {/* Welcome message centered */}
          <div
            className="flex-1 flex items-center justify-center pt-3"
            style={{
              minHeight: 'calc(100% - var(--panel-header-height))',
              paddingBottom: composerHeight + 16,
            }}
          >
            <div className="text-center text-muted-foreground">
              <Sparkles className="mx-auto mb-2 size-6" />
              <p>Start a new thread</p>
            </div>
          </div>
        </div>

        {/* Input at bottom - absolute positioned */}
        <div className="absolute bottom-0 inset-x-0 z-20">
          <TurnInput
            projectId={projectId}
            focusKey={`${activeThreadId ?? 'none'}:${threadFocusVersion}`}
            onHeightChange={setComposerHeight}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="thread-main">
      {/* Scroll container - full height, scrollbar extends full panel */}
      <div
        ref={setScrollContainer}
        data-thread-scroll-container="1"
        className="h-full overflow-y-auto overflow-x-hidden scroll-pt-[var(--panel-header-height)]"
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

        {/* Content wrapper - padding-bottom ensures last turn isn't hidden behind composer */}
        <div
          ref={listRef}
          className="relative min-w-0 flex flex-col pt-3"
          style={{
            paddingBottom: composerHeight + 16, // actual height + small buffer
          }}
        >
          {/* TurnList always renders (allows layout to stabilize and scroll to happen invisibly).
              Made invisible until scroll completes, then revealed. */}
          <div className={`flex-1 ${isContentReady ? '' : 'opacity-0 pointer-events-none'}`}>
            <TurnList
              turnIds={turnIds}
            />
          </div>

        </div>
      </div>

      {/* Composer OUTSIDE scroll - absolute positioned at bottom (floats over scroll container) */}
      <div className="absolute bottom-0 inset-x-0 z-20">
        {/* Floating scroll-to-bottom button - positioned above composer */}
        <ScrollToBottomButton visible={showScrollButton} onClick={scrollToBottom} />
        <TurnInput
          threadId={activeThread.id}
          focusKey={`${activeThreadId ?? 'none'}:${threadFocusVersion}`}
          onHeightChange={setComposerHeight}
        />
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
