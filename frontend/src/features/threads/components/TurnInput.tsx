import { useState, useEffect, useMemo } from 'react'
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
}

export function TurnInput({ threadId, projectId, focusKey }: TurnInputProps) {
  const [value, setValue] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Thread preferences from dedicated store (persisted globally, session-aware)
  const { currentOptions, initOptionsForThread, updateOptionsManually } = useThreadPrefsStore()

  const { createTurn, startNewThread, isLoadingTurns, streamingTurnId, interruptStreamingTurn, turns } = useThreadStore(
    useShallow((s) => ({
      createTurn: s.createTurn,
      startNewThread: s.startNewThread,
      isLoadingTurns: s.isLoadingTurns,
      streamingTurnId: s.streamingTurnId,
      interruptStreamingTurn: s.interruptStreamingTurn,
      turns: s.turns,
    })),
  )

  const { setActiveThread } = useUIStore(useShallow((s) => ({
    setActiveThread: s.setActiveThread,
  })))

  // Get last turn's request params (for per-thread preference)
  const lastTurnParams = useMemo(() => {
    if (!turns || turns.length === 0) return null
    // Find the last turn with requestParams (usually the last user turn)
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]?.requestParams) {
        return turns[i]?.requestParams
      }
    }
    return null
  }, [turns])

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
  // Responsive padding: px-3 on mobile, px-3.5 on sm+
  return (
    <div className="thread-input-shell">
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
