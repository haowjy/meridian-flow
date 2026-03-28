import { ActivityBlock } from "@/features/activity-stream"

import type { ThreadTurn } from "../types"

import { SiblingNav } from "./SiblingNav"
import { UserBubble } from "./UserBubble"

type TurnRowProps = {
  turn: ThreadTurn
  onSwitchSibling?: (targetTurnId: string) => void
}

export function TurnRow({ turn, onSwitchSibling }: TurnRowProps) {
  const hasSiblings = turn.siblingIds.length > 1
  const previousSiblingId = hasSiblings ? turn.siblingIds[turn.siblingIndex - 1] : undefined
  const nextSiblingId = hasSiblings ? turn.siblingIds[turn.siblingIndex + 1] : undefined

  const handlePrevious = previousSiblingId
    ? () => {
        onSwitchSibling?.(previousSiblingId)
      }
    : undefined

  const handleNext = nextSiblingId
    ? () => {
        onSwitchSibling?.(nextSiblingId)
      }
    : undefined

  if (turn.role === "system") {
    return null
  }

  return (
    <div>
      {hasSiblings ? (
        <SiblingNav
          current={turn.siblingIndex}
          total={turn.siblingIds.length}
          onPrevious={handlePrevious}
          onNext={handleNext}
        />
      ) : null}

      {turn.role === "user" ? (
        <UserBubble turn={turn} />
      ) : (
        <div className="pr-10">
          <ActivityBlock activity={turn.activity} />
        </div>
      )}
    </div>
  )
}
