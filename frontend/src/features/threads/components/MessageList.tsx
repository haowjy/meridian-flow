import { UserTurn } from './UserTurn'
import { AssistantTurn } from './AssistantTurn'
import { useThreadStore } from '@/core/stores/useThreadStore'

interface TurnListProps {
  turnIds: string[]
}

/**
 * Center-panel turn list.
 *
 * Responsibilities:
 * - Render thread turns in a centered column.
 * - Dispatch each turn to the appropriate bubble component.
 * - Auto-scroll to target turn when thread opens.
 *
 * Note: Parent (ActiveThreadView) handles scrolling - this component just renders content.
 */
function TurnRow({ turnId }: { turnId: string }) {
  const turn = useThreadStore((s) => s.turnById[turnId])
  if (!turn) return null
  return turn.role === 'user' ? <UserTurn turn={turn} /> : <AssistantTurn turn={turn} />
}

export function TurnList({ turnIds }: TurnListProps) {
  return (
    <div className="flex flex-col gap-3 py-3 px-6 w-full max-w-3xl mx-auto min-w-0 overflow-hidden">
      {turnIds.map((turnId) => (
        <TurnRow key={turnId} turnId={turnId} />
      ))}
    </div>
  )
}
