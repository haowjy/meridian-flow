import type { ThreadTurn } from "../types"

import { TurnRow } from "./TurnRow"

type TurnListProps = {
  turns: ThreadTurn[]
  onSwitchSibling?: (targetTurnId: string) => void
  onEditTurn?: (turnId: string) => void
  onRegenerateTurn?: (turnId: string) => void
}

export function TurnList({ turns, onSwitchSibling, onEditTurn, onRegenerateTurn }: TurnListProps) {
  return (
    <div className="min-w-0 space-y-4">
      {turns.map((turn) => (
        <TurnRow
          key={turn.id}
          turn={turn}
          onSwitchSibling={onSwitchSibling}
          onEditTurn={onEditTurn}
          onRegenerateTurn={onRegenerateTurn}
        />
      ))}
    </div>
  )
}
