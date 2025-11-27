"use client"

import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@/core/stores/useChatStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { ChatRequestControls } from '@/features/chats/components/ChatRequestControls'
import { AutosizeTextarea } from '@/features/chats/components/AutosizeTextarea'
import type { ChatRequestOptions } from '@/features/chats/types'
import { DEFAULT_CHAT_REQUEST_OPTIONS } from '@/features/chats/types'

interface TurnInputProps {
  chatId?: string      // Existing chat
  projectId?: string   // Cold start (no chat yet)
  /** When this value changes, focus the input. Parent controls timing, component handles mechanics. */
  focusKey?: string | null
}

const DEFAULT_MODEL_ID = 'moonshotai/kimi-k2-thinking'
const DEFAULT_MODEL_LABEL = 'Kimi K2 Thinking'
const DEFAULT_PROVIDER_ID = 'openrouter'

export function TurnInput({ chatId, projectId, focusKey }: TurnInputProps) {
  const [value, setValue] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [options, setOptions] = useState<ChatRequestOptions>({
    ...DEFAULT_CHAT_REQUEST_OPTIONS,
    modelId: DEFAULT_MODEL_ID,
    modelLabel: DEFAULT_MODEL_LABEL,
    providerId: DEFAULT_PROVIDER_ID,
  })

  const { createTurn, startNewChat, isLoadingTurns, streamingTurnId, interruptStreamingTurn } = useChatStore(
    useShallow((s) => ({
      createTurn: s.createTurn,
      startNewChat: s.startNewChat,
      isLoadingTurns: s.isLoadingTurns,
      streamingTurnId: s.streamingTurnId,
      interruptStreamingTurn: s.interruptStreamingTurn,
    })),
  )

  const setActiveChat = useUIStore((s) => s.setActiveChat)

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
        await createTurn(chatId, messageText, options)
      } else if (projectId) {
        // Cold start flow - creates chat atomically
        const chat = await startNewChat(projectId, messageText, options)
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
            options={options}
            onOptionsChange={setOptions}
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
