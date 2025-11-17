"use client"

import type { Turn } from '@/features/chats/types'
import { cn } from '@/lib/utils'
import { Card } from '@/shared/components/ui/card'

interface UserTurnProps {
  turn: Turn
}

/**
 * User turn bubble.
 *
 * Single responsibility:
 * - Render a user-authored turn as a right-aligned bubble.
 */
export function UserTurn({ turn }: UserTurnProps) {
  return (
    <div className="flex justify-end">
      <Card className={cn('max-w-3xl px-3 py-2 text-sm', 'chat-message chat-message--user')}>
        {turn.content}
      </Card>
    </div>
  )
}
