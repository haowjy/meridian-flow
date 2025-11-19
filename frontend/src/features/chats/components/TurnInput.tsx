"use client"

import { useState, KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Send } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { useChatStore } from '@/core/stores/useChatStore'

interface TurnInputProps {
  chatId: string
}

/**
 * Input row for sending a new user turn.
 *
 * For now, this calls useChatStore.createTurn as a thin wrapper.
 * Later, it will be wired to full CreateTurn + SSE integration.
 */
export function TurnInput({ chatId }: TurnInputProps) {
  const [value, setValue] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { createTurn, isLoadingTurns } = useChatStore(useShallow((s) => ({
    createTurn: s.createTurn,
    isLoadingTurns: s.isLoadingTurns,
  })))

  // Prevent sending empty or whitespace-only messages
  // Also prevent concurrent submissions (race condition protection)
  const canSend = value.trim().length > 0 && !isLoadingTurns && !isSubmitting

  const handleSend = async () => {
    if (!canSend) return
    const content = value.trim()
    setValue('')

    setIsSubmitting(true)
    try {
      await createTurn(chatId, content)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  return (
    <div className="chat-input-shell">
      <div className="chat-input-row">
        <textarea
          rows={1}
          className="chat-input"
          placeholder="Send a message..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <Button
          type="button"
          size="icon"
          className="shrink-0"
          disabled={!canSend}
          onClick={handleSend}
          aria-label="Send message"
        >
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  )
}
