import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Pencil, Trash2, ChevronDown } from 'lucide-react'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useThreadPrefsStore } from '@/core/stores/useThreadPrefsStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { ThreadRequestControls } from '@/features/threads/components/ThreadRequestControls'
import { AutosizeTextarea } from '@/features/threads/components/AutosizeTextarea'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/lib/utils'
import { makeLogger } from '@/core/lib/logger'

const log = makeLogger('TurnInput')

interface TurnInputProps {
  threadId?: string      // Existing thread
  projectId?: string   // Cold start (no thread yet)
  /** When this value changes, focus the input. Parent controls timing, component handles mechanics. */
  focusKey?: string | null
  /** Callback when composer height changes (for dynamic padding in parent) */
  onHeightChange?: (height: number) => void
}

export function TurnInput({ threadId, projectId, focusKey, onHeightChange }: TurnInputProps) {
  const [value, setValue] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [queueExpanded, setQueueExpanded] = useState(false)
  const [isTruncated, setIsTruncated] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const collapsedPreviewRef = useRef<HTMLDivElement>(null)
  const expandedContentRef = useRef<HTMLDivElement>(null)

  // Measure and report height to parent for dynamic padding
  useLayoutEffect(() => {
    if (!containerRef.current || !onHeightChange) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        onHeightChange(entry.contentRect.height)
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [onHeightChange])

  // Thread preferences from dedicated store (persisted globally, session-aware)
  const { currentOptions, initOptionsForThread, updateOptionsManually } = useThreadPrefsStore()

  const {
    createTurn,
    startNewThread,
    isLoadingTurns,
    streamingTurnId,
    interruptStreamingTurn,
    submitInterjection,
    clearInterjection,
    interjectionContent,
  } = useThreadStore(
    useShallow((s) => ({
      createTurn: s.createTurn,
      startNewThread: s.startNewThread,
      isLoadingTurns: s.isLoadingTurns,
      streamingTurnId: s.streamingTurnId,
      interruptStreamingTurn: s.interruptStreamingTurn,
      submitInterjection: s.submitInterjection,
      clearInterjection: s.clearInterjection,
      interjectionContent: s.interjectionContent,
    })),
  )

  const { setActiveThread } = useUIStore(useShallow((s) => ({
    setActiveThread: s.setActiveThread,
  })))

  // Get last turn's request params (for per-thread preference).
  // Selector returns a stable reference unless requestParams actually changes,
  // avoiding re-renders on high-frequency streaming deltas.
  const lastTurnParams = useThreadStore((s) => {
    for (let i = s.turnIds.length - 1; i >= 0; i--) {
      const id = s.turnIds[i]
      if (!id) continue
      const t = s.turnById[id]
      if (t?.requestParams) return t.requestParams
    }
    return null
  })

  // Re-initialize options when thread changes or on mount
  // Store handles new-thread vs existing-thread logic internally
  useEffect(() => {
    initOptionsForThread(threadId, lastTurnParams)
  }, [threadId, lastTurnParams, initOptionsForThread])

  // Detect if interjection content is truncated
  // Collapsed: check if line-clamp-2 truncates the text
  // Expanded: check if scrollable area has overflow
  useLayoutEffect(() => {
    const el = queueExpanded ? expandedContentRef.current : collapsedPreviewRef.current
    if (!el) {
      setIsTruncated(false)
      return
    }
    // Check if content overflows the visible area
    setIsTruncated(el.scrollHeight > el.clientHeight)
  }, [interjectionContent, queueExpanded])

  const isStreaming = Boolean(streamingTurnId)

  // Can send a normal message if: has text, not loading, not submitting, not streaming, and has either threadId or projectId
  const canSendMessage =
    value.trim().length > 0 && !isLoadingTurns && !isSubmitting && !isStreaming && (Boolean(threadId) || Boolean(projectId))

  // Can send an interjection if: has text, not submitting, IS streaming, and has a streaming turn ID
  const canInterject =
    value.trim().length > 0 && !isSubmitting && isStreaming && Boolean(streamingTurnId)

  // Combined: can send either way
  const canSend = canSendMessage || canInterject

  // Load interjection content into textarea for editing
  // Clears from queue first (indicator disappears), then loads into textarea
  const loadInterjectionForEdit = useCallback(async () => {
    if (!interjectionContent || !streamingTurnId) return

    // Save content before clearing (it will be nulled after clear)
    const content = interjectionContent
    log.debug('loadInterjectionForEdit', { contentLength: content.length })

    // Clear from queue first (API call) - indicator disappears
    await clearInterjection(streamingTurnId)

    // Now load into textarea
    setValue(content)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      // Position cursor at end of text
      const len = el.value.length
      el.setSelectionRange(len, len)
    })
  }, [interjectionContent, streamingTurnId, clearInterjection])

  // Clear queued interjection
  const handleClearInterjection = useCallback(async () => {
    if (streamingTurnId && interjectionContent) {
      log.debug('handleClearInterjection', { streamingTurnId })
      await clearInterjection(streamingTurnId)
    }
  }, [streamingTurnId, interjectionContent, clearInterjection])

  // Send handler (must be before handleKeyDown since it's used there)
  const handleSend = useCallback(async () => {
    if (!canSend) return
    const messageText = value.trim()
    setValue('')

    setIsSubmitting(true)
    try {
      if (isStreaming && streamingTurnId) {
        // Interjection flow - always 'append' since queue is cleared before editing
        log.debug('handleSend:interjection', { streamingTurnId, contentLength: messageText.length })
        await submitInterjection(streamingTurnId, messageText, 'append')
      } else if (threadId) {
        // Existing thread flow
        await createTurn(threadId, messageText, currentOptions)
      } else if (projectId) {
        // Cold start flow - creates thread atomically
        const thread = await startNewThread(projectId, messageText, currentOptions)
        setActiveThread(thread.id)
      }
    } finally {
      setIsSubmitting(false)
    }
  }, [canSend, value, isStreaming, streamingTurnId, submitInterjection, threadId, createTurn, currentOptions, projectId, startNewThread, setActiveThread])

  // Consolidated keyboard handling (all keyboard logic in one place)
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter → submit (normal message or interjection)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) handleSend()
      return
    }

    // ArrowUp in empty textarea → load interjection for editing
    if (e.key === 'ArrowUp' && value === '' && interjectionContent && streamingTurnId) {
      e.preventDefault()
      loadInterjectionForEdit()
      return
    }

    // Escape key handling:
    // - If interjection queued → clear it
    // - Else if streaming → stop streaming
    if (e.key === 'Escape') {
      if (interjectionContent && streamingTurnId) {
        e.preventDefault()
        handleClearInterjection()
      } else if (isStreaming) {
        e.preventDefault()
        interruptStreamingTurn()
      }
      return
    }
  }, [canSend, handleSend, value, interjectionContent, streamingTurnId, isStreaming, loadInterjectionForEdit, handleClearInterjection, interruptStreamingTurn])

  // Show pending interjection content if present (received via SSE)
  // This visual indicator shows what's been queued server-side
  const showInterjectionIndicator = isStreaming && interjectionContent

  // Unified layout for both mobile and desktop
  // Auto-expanding composer - textarea grows up to max height, then scrolls internally
  return (
    <div ref={containerRef} className="thread-input-shell">
      <div className="mx-auto w-full max-w-3xl">
        {/* Queued interjection indicator - ABOVE composer, visually connected */}
        {/* Collapsed: 2-line preview, click anywhere to expand, icons centered */}
        {/* Expanded: full content inline (scrollable), only chevron collapses, icons at top */}
        {showInterjectionIndicator && (
          <div className="mx-2 rounded-t-lg border border-b-0 border-border/60 bg-muted py-0.5">
            {/* Single row layout - icons float to top when expanded */}
            <div className={cn(
              "flex gap-1 px-2 py-1.5",
              queueExpanded ? "items-start" : "items-center"
            )}>
              {/* Chevron - always clickable to toggle */}
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 [&_svg]:size-3"
                onClick={() => setQueueExpanded((v) => !v)}
                title={queueExpanded ? "Collapse" : "Expand"}
              >
                <ChevronDown className={cn(
                  "transition-transform duration-150",
                  !queueExpanded && "rotate-180"
                )} />
              </Button>

              {/* Content area - clickable only when collapsed, selectable when expanded */}
              <div
                onClick={queueExpanded ? undefined : () => setQueueExpanded(true)}
                className={cn(
                  "relative min-w-0 flex-1",
                  !queueExpanded && "cursor-pointer"
                )}
                title={queueExpanded ? undefined : "Expand"}
              >
                <div
                  ref={queueExpanded ? expandedContentRef : collapsedPreviewRef}
                  className={cn(
                    "whitespace-pre-wrap break-words text-sm text-muted-foreground",
                    queueExpanded ? "max-h-24 overflow-y-auto" : "line-clamp-2"
                  )}
                >
                  {interjectionContent}
                </div>
                {/* Gradient fade indicates more content is hidden */}
                {isTruncated && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-muted/30 to-transparent" />
                )}
              </div>

              {/* Action icons - float to top when expanded */}
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="[&_svg]:size-3"
                  onClick={loadInterjectionForEdit}
                  title="Edit"
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="[&_svg]:size-3"
                  onClick={handleClearInterjection}
                  title="Delete (Esc)"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          </div>
        )}
        <div className={cn(
          "flex flex-col border border-border/60 bg-card shadow-sm transition-shadow focus-within:border-border focus-within:shadow-md",
          showInterjectionIndicator ? "rounded-b-lg" : "rounded-lg"
        )} style={{ boxShadow: 'var(--shadow-1)' }}>
          <div className="px-2 py-1.5 sm:px-2.5 sm:py-2">
            <AutosizeTextarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            focusKey={focusKey}
            placeholder={isStreaming ? "Interject while streaming..." : "Type a message..."}
            onKeyDown={handleKeyDown}
          />
          <ThreadRequestControls
            options={currentOptions}
            onOptionsChange={updateOptionsManually}
            onSend={handleSend}
            isSendDisabled={!canSend}
            isStreaming={isStreaming}
            onStop={interruptStreamingTurn}
            isInterjectionMode={isStreaming && value.trim().length > 0}
          />
          </div>
        </div>
      </div>
    </div>
  )
}
