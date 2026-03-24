import { AgentDetail } from "./AgentDetail"
import { BashDetail } from "./BashDetail"
import { DetailCard } from "./DetailCard"
import { EditDetail } from "./EditDetail"
import { ReadDetail } from "./ReadDetail"
import { DocSearchDetail } from "./SearchDetail"
import { WebSearchDetail } from "./WebSearchDetail"
import type { ToolItem } from "./types"

type ToolDetailProps = {
  tool: ToolItem
}

export function ToolDetail({ tool }: ToolDetailProps) {
  if (tool.detail?.kind === "read") {
    return <ReadDetail detail={tool.detail} />
  }

  if (tool.detail?.kind === "edit") {
    return <EditDetail detail={tool.detail} />
  }

  if (tool.detail?.kind === "doc-search") {
    return <DocSearchDetail detail={tool.detail} />
  }

  if (tool.detail?.kind === "web-search") {
    return <WebSearchDetail detail={tool.detail} />
  }

  if (tool.detail?.kind === "bash") {
    return <BashDetail detail={tool.detail} />
  }

  if (tool.detail?.kind === "agent") {
    return <AgentDetail detail={tool.detail} />
  }

  // Generic fallback for unknown tool types
  return (
    <DetailCard className="[&>div]:p-3">
      <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs text-muted-foreground">
        {JSON.stringify(tool.args ?? {}, null, 2)}
      </pre>
    </DetailCard>
  )
}
