"use client"

import type { Turn } from '@/features/chats/types'
import { Card } from '@/shared/components/ui/card'

interface AssistantTurnProps {
  turn: Turn
}

/**
 * Assistant turn bubble.
 *
 * Single responsibility:
 * - Render assistant content as a left-aligned bubble.
 *
 * Markdown, thinking blocks, and actions will be layered on later.
 */
export function AssistantTurn({ turn }: AssistantTurnProps) {
  return (
    <div className="flex justify-start">
      <Card className="max-w-3xl px-3 py-2 text-sm chat-message chat-message--ai">
        {turn.content}
      </Card>
    </div>
  )
}
