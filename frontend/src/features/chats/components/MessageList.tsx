import { useRef } from 'react'
import type { Turn } from '@/features/chats/types'
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
 * - Render chat turns in a centered column.
 * - Dispatch each turn to the appropriate bubble component.
 * - Auto-scroll to target turn when chat opens.
 *
 * Note: Parent (ActiveChatView) handles scrolling - this component just renders content.
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
    <div ref={containerRef} className="flex flex-col gap-3 py-3 px-6 w-full max-w-3xl mx-auto min-w-0 overflow-hidden">
      {turns.map((turn) =>
        turn.role === 'user' ? (
          <UserTurn key={turn.id} turn={turn} />
        ) : (
          <AssistantTurn key={turn.id} turn={turn} />
        )
      )}
    </div>
  )
}
