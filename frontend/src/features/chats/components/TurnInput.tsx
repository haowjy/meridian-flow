import { useState, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@/core/stores/useChatStore'
import { useChatPrefsStore } from '@/core/stores/useChatPrefsStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { ChatRequestControls } from '@/features/chats/components/ChatRequestControls'
import { AutosizeTextarea } from '@/features/chats/components/AutosizeTextarea'

interface TurnInputProps {
  chatId?: string      // Existing chat
  projectId?: string   // Cold start (no chat yet)
  /** When this value changes, focus the input. Parent controls timing, component handles mechanics. */
  focusKey?: string | null
}

export function TurnInput({ chatId, projectId, focusKey }: TurnInputProps) {
  const [value, setValue] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Chat preferences from dedicated store (persisted globally, session-aware)
  const { currentOptions, initOptionsForChat, updateOptionsManually } = useChatPrefsStore()

  const { createTurn, startNewChat, isLoadingTurns, streamingTurnId, interruptStreamingTurn, turns } = useChatStore(
    useShallow((s) => ({
      createTurn: s.createTurn,
      startNewChat: s.startNewChat,
      isLoadingTurns: s.isLoadingTurns,
      streamingTurnId: s.streamingTurnId,
      interruptStreamingTurn: s.interruptStreamingTurn,
      turns: s.turns,
    })),
  )

  const setActiveChat = useUIStore((s) => s.setActiveChat)

  // Get last turn's request params (for per-conversation preference)
  const lastTurnParams = useMemo(() => {
    if (!turns || turns.length === 0) return null
    // Find the last turn with requestParams (usually the last user turn)
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].requestParams) {
        return turns[i].requestParams
      }
    }
    return null
  }, [turns])

  // Re-initialize options when chat changes or on mount
  // Store handles new-chat vs existing-chat logic internally
  useEffect(() => {
    initOptionsForChat(chatId, lastTurnParams)
  }, [chatId, lastTurnParams, initOptionsForChat])

  const isStreaming = Boolean(streamingTurnId)

  // Can send if: has text, not loading, not submitting, not streaming, and has either chatId or projectId
  const canSend =
    value.trim().length > 0 && !isLoadingTurns && !isSubmitting && !isStreaming && (Boolean(chatId) || Boolean(projectId))

  const handleSend = async () => {
    if (!canSend) return
    const messageText = value.trim()
    setValue('')

    setIsSubmitting(true)
    try {
      if (chatId) {
        // Existing chat flow
        await createTurn(chatId, messageText, currentOptions)
      } else if (projectId) {
        // Cold start flow - creates chat atomically
        const chat = await startNewChat(projectId, messageText, currentOptions)
        setActiveChat(chat.id)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="chat-input-shell">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex flex-col rounded-xl bg-card px-3 py-2 shadow-md">
          <AutosizeTextarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onSubmit={handleSend}
            canSend={canSend}
            focusKey={focusKey}
          />
          <AttachedBlocksRow />
          <ChatRequestControls
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
