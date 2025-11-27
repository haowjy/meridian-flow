"use client"

import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@/core/stores/useChatStore'
import { ChatRequestControls } from '@/features/chats/components/ChatRequestControls'
import type { ChatRequestOptions } from '@/features/chats/types'
import { DEFAULT_CHAT_REQUEST_OPTIONS } from '@/features/chats/types'

interface TurnInputProps {
  chatId: string
}

const DEFAULT_MODEL_ID = 'moonshotai/kimi-k2-thinking'
const DEFAULT_MODEL_LABEL = 'Kimi K2 Thinking'
const DEFAULT_PROVIDER_ID = 'openrouter'

export function TurnInput({ chatId }: TurnInputProps) {
  const [value, setValue] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [options, setOptions] = useState<ChatRequestOptions>({
    ...DEFAULT_CHAT_REQUEST_OPTIONS,
    modelId: DEFAULT_MODEL_ID,
    modelLabel: DEFAULT_MODEL_LABEL,
    providerId: DEFAULT_PROVIDER_ID,
  })

  const { createTurn, isLoadingTurns, streamingTurnId, interruptStreamingTurn } = useChatStore(
    useShallow((s) => ({
      createTurn: s.createTurn,
      isLoadingTurns: s.isLoadingTurns,
      streamingTurnId: s.streamingTurnId,
      interruptStreamingTurn: s.interruptStreamingTurn,
    })),
  )

  const isStreaming = Boolean(streamingTurnId)

  const canSend =
    value.trim().length > 0 && !isLoadingTurns && !isSubmitting && !isStreaming

  const handleSend = async () => {
    if (!canSend) return
    const messageText = value.trim()
    setValue('')

    setIsSubmitting(true)
    try {
      await createTurn(chatId, messageText, options)
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
            onChange={setValue}
            onSubmit={handleSend}
            canSend={canSend}
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

interface AutosizeTextareaProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  canSend: boolean
}

function AutosizeTextarea({
  value,
  onChange,
  onSubmit,
  canSend,
}: AutosizeTextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    el.style.height = 'auto'
    const maxHeight = 240
    const next = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${next}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      rows={2}
      className="w-full min-h-[3rem] resize-none bg-transparent px-2 pt-1 pb-1 text-sm outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus:ring-offset-0"
      placeholder="Send a message..."
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          if (canSend) onSubmit()
        }
      }}
    />
  )
}

function AttachedBlocksRow() {
  return null
}
