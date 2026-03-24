import { useActivityNesting } from "./activity-context"
import { DetailCard } from "./DetailCard"
import type { AgentToolDetail } from "./types"

type AgentDetailProps = {
  detail: AgentToolDetail
}

export function AgentDetail({ detail }: AgentDetailProps) {
  const { depth, renderNestedActivity } = useActivityNesting()
  const { agent } = detail

  return (
    <div className="space-y-2">
      <DetailCard accent className="[&>div]:p-3">
        {renderNestedActivity(agent.activity, depth + 1)}
      </DetailCard>

      {agent.response ? (
        <p className="text-sm text-muted-foreground">{agent.response}</p>
      ) : null}
    </div>
  )
}
