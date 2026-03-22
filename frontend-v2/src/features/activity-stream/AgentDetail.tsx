import type { ReactNode } from "react"

import { Robot } from "@phosphor-icons/react"

import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

import type { ActivityBlockData, AgentToolDetail } from "./types"

type AgentDetailProps = {
  detail: AgentToolDetail
  depth: number
  renderNestedActivity: (activity: ActivityBlockData, depth: number) => ReactNode
}

export function AgentDetail({ detail, depth, renderNestedActivity }: AgentDetailProps) {
  const { agent } = detail

  return (
    <Card variant="outline" className="gap-0 rounded-md border-border/70 border-l-2 border-l-accent-fill bg-card/90 py-0">
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center gap-2 text-sm">
          <Robot className="size-4 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium text-foreground">Agent: {agent.name}</p>
        </div>

        {renderNestedActivity(agent.activity, depth + 1)}

        {agent.response ? (
          <>
            <Separator />
            <p className="font-editor text-sm leading-relaxed text-foreground">{agent.response}</p>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
