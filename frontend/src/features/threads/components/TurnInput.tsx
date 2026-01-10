import { useState, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowUp, SlidersHorizontal, StopCircle } from 'lucide-react'
import { useThreadStore } from '@/core/stores/useThreadStore'
import { useThreadPrefsStore } from '@/core/stores/useThreadPrefsStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useIsMobile } from '@/core/hooks/useIsMobile'
import { ThreadRequestControls } from '@/features/threads/components/ThreadRequestControls'
import { AutosizeTextarea } from '@/features/threads/components/AutosizeTextarea'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/lib/utils'

interface TurnInputProps {
  threadId?: string      // Existing thread
  projectId?: string   // Cold start (no thread yet)
  /** When this value changes, focus the input. Parent controls timing, component handles mechanics. */
  focusKey?: string | null
}

export function TurnInput({ threadId, projectId, focusKey }: TurnInputProps) {
  const [value, setValue] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isMobile = useIsMobile()
  const [showAdvanced, setShowAdvanced] = useState(() => !isMobile)

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

  // On desktop, always show advanced controls. On mobile, user can toggle.
  useEffect(() => {
    if (!isMobile) setShowAdvanced(true)
  }, [isMobile])

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

  const handlePrimaryAction = () => {
    if (isStreaming) interruptStreamingTurn()
    else void handleSend()
  }

  const primaryLabel = isStreaming ? 'Stop response' : 'Send message'
  const primaryDisabled = isStreaming ? false : !canSend

  if (isMobile) {
    return (
      <div className="thread-input-shell">
        <div className="mx-auto w-full max-w-3xl">
          <div className="flex flex-col rounded-xl bg-card px-2 py-2 shadow-md">
            <div className="flex items-end gap-2">
              <AutosizeTextarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onSubmit={handleSend}
                canSend={canSend}
                focusKey={focusKey}
                placeholder="Type a message..."
                className="px-1"
              />
              <Button
                type="button"
                size="icon"
                className="shrink-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
                disabled={primaryDisabled}
                onClick={handlePrimaryAction}
                aria-label={primaryLabel}
                title={primaryLabel}
              >
                {isStreaming ? <StopCircle className="size-4" /> : <ArrowUp className="size-4" />}
              </Button>
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <button
                type="button"
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-[0.7rem] text-muted-foreground',
                  'hover:text-foreground'
                )}
                onClick={() => setShowAdvanced((v) => !v)}
                aria-label={showAdvanced ? 'Hide thread options' : 'Show thread options'}
              >
                <SlidersHorizontal className="size-3" />
                <span className="truncate">{currentOptions.modelLabel}</span>
              </button>

              {isStreaming && (
                <span className="text-[0.7rem] text-muted-foreground">Streaming…</span>
              )}
            </div>

            {showAdvanced && (
              <ThreadRequestControls
                options={currentOptions}
                onOptionsChange={updateOptionsManually}
                showSend={false}
              />
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="thread-input-shell">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex flex-col rounded-xl bg-card px-3 py-2 shadow-md">
          <AutosizeTextarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onSubmit={handleSend}
            canSend={canSend}
            focusKey={focusKey}
            placeholder="Type a message..."
          />
          <AttachedBlocksRow />
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

function AttachedBlocksRow() {
  return null
}
