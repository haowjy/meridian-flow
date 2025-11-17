"use client"

import type { Turn } from '@/features/chats/types'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { UserTurn } from './UserTurn'
import { AssistantTurn } from './AssistantTurn'

interface TurnListProps {
  turns: Turn[]
}

/**
 * Center-panel turn list.
 *
 * Responsibilities:
 * - Layout + scroll container for chat turns.
 * - Dispatch each turn to the appropriate bubble component.
 *
 * No data fetching or SSE logic here.
 */
export function TurnList({ turns }: TurnListProps) {
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 px-4 py-3">
        {turns.map((turn) =>
          turn.role === 'user' ? (
            <UserTurn key={turn.id} turn={turn} />
          ) : (
            <AssistantTurn key={turn.id} turn={turn} />
          )
        )}
      </div>
    </ScrollArea>
  )
}
