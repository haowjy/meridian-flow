import type { ReactNode } from "react"

import { Card, CardContent } from "@/components/ui/card"

import { AgentDetail } from "./AgentDetail"
import { BashDetail } from "./BashDetail"
import { EditDetail } from "./EditDetail"
import { ReadDetail } from "./ReadDetail"
import { DocSearchDetail } from "./SearchDetail"
import { WebSearchDetail } from "./WebSearchDetail"
import type { ActivityBlockData, ToolItem } from "./types"

type ToolDetailProps = {
  tool: ToolItem
  depth: number
  renderNestedActivity: (activity: ActivityBlockData, depth: number) => ReactNode
  className?: string
}

export function ToolDetail({ tool, depth, renderNestedActivity, className }: ToolDetailProps) {
  if (tool.detail?.kind === "read") {
    return (
      <div className={className}>
        <ReadDetail detail={tool.detail} />
      </div>
    )
  }

  if (tool.detail?.kind === "edit") {
    return (
      <div className={className}>
        <EditDetail detail={tool.detail} />
      </div>
    )
  }

  if (tool.detail?.kind === "doc-search") {
    return (
      <div className={className}>
        <DocSearchDetail detail={tool.detail} />
      </div>
    )
  }

  if (tool.detail?.kind === "web-search") {
    return (
      <div className={className}>
        <WebSearchDetail detail={tool.detail} />
      </div>
    )
  }

  if (tool.detail?.kind === "bash") {
    return (
      <div className={className}>
        <BashDetail detail={tool.detail} />
      </div>
    )
  }

  if (tool.detail?.kind === "agent") {
    return (
      <div className={className}>
        <AgentDetail detail={tool.detail} depth={depth} renderNestedActivity={renderNestedActivity} />
      </div>
    )
  }

  return (
    <div className={className}>
      <Card variant="outline" className="gap-0 rounded-md border-border/70 py-0">
        <CardContent className="space-y-2 p-3">
          <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs text-muted-foreground">
            {JSON.stringify(tool.args ?? {}, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
