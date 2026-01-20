import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useThreadPrefsStore } from '@/core/stores/useThreadPrefsStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { ThreadRequestControls } from '@/features/threads/components/ThreadRequestControls'
import { AutosizeTextarea } from '@/features/threads/components/AutosizeTextarea'

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
  const containerRef = useRef<HTMLDivElement>(null)

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

  const { createTurn, startNewThread, isLoadingTurns, streamingTurnId, interruptStreamingTurn } = useThreadStore(
    useShallow((s) => ({
      createTurn: s.createTurn,
      startNewThread: s.startNewThread,
      isLoadingTurns: s.isLoadingTurns,
      streamingTurnId: s.streamingTurnId,
      interruptStreamingTurn: s.interruptStreamingTurn,
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

  const isStreaming = Boolean(streamingTurnId)

  // Can send if: has text, not loading, not submitting, not streaming, and has either threadId or projectId
  const canSend =
    value.trim().length > 0 && !isLoadingTurns && !isSubmitting && !isStreaming && (Boolean(threadId) || Boolean(projectId))

  const handleSend = async () => {
    if (!canSend) return
    const messageText = value.trim()
    setValue('')

    setIsSubmitting(true)
    try {
      if (threadId) {
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
  }

  // Unified layout for both mobile and desktop
  // Auto-expanding composer - textarea grows up to max height, then scrolls internally
  return (
    <div ref={containerRef} className="thread-input-shell">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex flex-col rounded-lg border border-border/60 bg-card px-2 py-1.5 shadow-sm transition-shadow focus-within:border-border focus-within:shadow-md sm:px-2.5 sm:py-2">
          <AutosizeTextarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onSubmit={handleSend}
            canSend={canSend}
            focusKey={focusKey}
            placeholder="Type a message..."
          />
          <ThreadRequestControls
            options={currentOptions}
            onOptionsChange={updateOptionsManually}
            onSend={handleSend}
            isSendDisabled={!canSend}
            isStreaming={isStreaming}
            onStop={interruptStreamingTurn}
          />
        </div>
      </div>
    </div>
  )
}
