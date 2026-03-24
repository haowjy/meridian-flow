import { Terminal } from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"

import { DetailCard } from "./DetailCard"
import type { BashToolDetail } from "./types"

type BashDetailProps = {
  detail: BashToolDetail
}

export function BashDetail({ detail }: BashDetailProps) {
  return (
    <DetailCard className="[&>div]:space-y-3 [&>div]:p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
          <Terminal className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate font-mono">{detail.command}</span>
        </p>
        <Badge variant={detail.exitCode === 0 || detail.exitCode === undefined ? "success" : "destructive"}>
          {detail.exitCode === undefined ? "running" : `exit ${detail.exitCode}`}
        </Badge>
      </div>

      <div className="rounded-md border border-[#3B352F] bg-[#2A2520] p-2">
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap font-mono text-xs text-[#F0EBE3]">
          {detail.output}
        </pre>
      </div>
    </DetailCard>
  )
}
