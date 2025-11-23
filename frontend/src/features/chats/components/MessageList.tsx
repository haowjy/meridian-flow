"use client"

import { useRef } from 'react'
import type { Turn } from '@/features/chats/types'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { UserTurn } from './UserTurn'
import { AssistantTurn } from './AssistantTurn'
import { useTurnListAutoScroll } from '@/features/chats/hooks/useTurnListAutoScroll'

interface TurnListProps {
  turns: Turn[]
  scrollToTurnId?: string | null
  isLoading?: boolean
}

/**
 * Center-panel turn list.
 *
 * Responsibilities:
 * - Layout + scroll container for chat turns.
 * - Dispatch each turn to the appropriate bubble component.
 * - Auto-scroll to target turn when chat opens.
 *
 * No data fetching or SSE logic here.
 */
export function TurnList({ turns, scrollToTurnId, isLoading }: TurnListProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useTurnListAutoScroll({
    containerRef,
    turns,
    scrollToTurnId,
    isLoading,
  })

  return (
    <ScrollArea className="h-full">
      <div ref={containerRef} className="flex flex-col gap-3 px-4 py-3 w-full max-w-3xl mx-auto">
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
