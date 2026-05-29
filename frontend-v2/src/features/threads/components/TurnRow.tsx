import { Badge } from "@/components/ui/badge"
import { ActivityBlock } from "@/features/activity-stream"

import type { AssistantTurn, ThreadTurn } from "../types"

import { PendingTurn } from "./PendingTurn"
import { SiblingNav } from "./SiblingNav"
import { TurnActions } from "./TurnActions"
import { TurnStatusBanner } from "./TurnStatusBanner"
import { UserBubble } from "./UserBubble"

type TurnRowProps = {
  turn: ThreadTurn
  onSwitchSibling?: (targetTurnId: string) => void
  onEditTurn?: (turnId: string) => void
  onRegenerateTurn?: (turnId: string) => void
}

function hasRenderableActivity(turn: AssistantTurn): boolean {
  return turn.activity.items.length > 0 || Boolean(turn.activity.pendingText)
}

function ErrorTurn({ turn }: { turn: AssistantTurn }) {
  const errorMessage = turn.error ?? "An unexpected error interrupted this response."

  return (
    <div className="space-y-2">
      <TurnStatusBanner variant="error" message={errorMessage} />
      {hasRenderableActivity(turn) ? <ActivityBlock activity={turn.activity} /> : null}
    </div>
  )
}

function CancelledTurn({ turn }: { turn: AssistantTurn }) {
  return (
    <div className="space-y-2 opacity-70">
      <div className="flex items-center gap-2">
        <TurnStatusBanner variant="warning" message="This response was cancelled." className="flex-1" />
        <Badge variant="warning">Cancelled</Badge>
      </div>
      {hasRenderableActivity(turn) ? <ActivityBlock activity={turn.activity} /> : null}
    </div>
  )
}

function CreditLimitedTurn({ turn }: { turn: AssistantTurn }) {
  return (
    <div className="space-y-2">
      <TurnStatusBanner variant="warning" message={turn.error ?? "Credit limit reached."} />
      {hasRenderableActivity(turn) ? <ActivityBlock activity={turn.activity} /> : null}
    </div>
  )
}

export function TurnRow({ turn, onSwitchSibling, onEditTurn, onRegenerateTurn }: TurnRowProps) {
  const hasSiblings = turn.siblingIds.length > 1
  const previousSiblingId = hasSiblings ? turn.siblingIds[turn.siblingIndex - 1] : undefined
  const nextSiblingId = hasSiblings ? turn.siblingIds[turn.siblingIndex + 1] : undefined
  const isTerminal = turn.status === "complete" || turn.status === "error" || turn.status === "cancelled"

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

  const content =
    turn.role === "assistant" ? (
      turn.status === "pending" ? (
        <PendingTurn />
      ) : turn.status === "error" ? (
        <ErrorTurn turn={turn} />
      ) : turn.status === "cancelled" ? (
        <CancelledTurn turn={turn} />
      ) : turn.status === "credit_limited" ? (
        <CreditLimitedTurn turn={turn} />
      ) : (
        <div>
          <ActivityBlock
            // Remount when transitioning out of waiting_subagents so internal
            // expanded state resets to the default for the new status.
            key={turn.status === "waiting_subagents" ? `${turn.id}-waiting` : turn.id}
            activity={turn.activity}
            isWaitingSubagents={turn.status === "waiting_subagents"}
            defaultExpanded={turn.status === "waiting_subagents"}
          />
        </div>
      )
    ) : (
      <UserBubble turn={turn} />
    )

  // Show actions only on terminal turns (not while streaming/pending)
  const showActions = isTerminal && (onEditTurn || onRegenerateTurn)

  return (
    <div className="group/turn min-w-0">
      {hasSiblings ? (
        <SiblingNav
          current={turn.siblingIndex}
          total={turn.siblingIds.length}
          onPrevious={handlePrevious}
          onNext={handleNext}
        />
      ) : null}

      {content}

      {showActions ? (
        <TurnActions
          turn={turn}
          onEdit={
            turn.role === "user" && onEditTurn
              ? () => onEditTurn(turn.id)
              : undefined
          }
          onRegenerate={
            turn.role === "assistant" && onRegenerateTurn
              ? () => onRegenerateTurn(turn.id)
              : undefined
          }
          className="mt-1"
        />
      ) : null}
    </div>
  )
}
