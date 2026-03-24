import { FileText } from "@phosphor-icons/react"

import { DetailCard } from "./DetailCard"
import type { ReadToolDetail } from "./types"

type ReadDetailProps = {
  detail: ReadToolDetail
}

export function ReadDetail({ detail }: ReadDetailProps) {
  return (
    <DetailCard>
      {detail.previewLines && detail.previewLines.length > 0 ? (
        <div className="space-y-1">
          {detail.previewLines.slice(0, 4).map((line, index) => (
            <p
              key={`${detail.filePath}-preview-${index}`}
              className="truncate font-mono text-xs text-muted-foreground"
            >
              {line}
            </p>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileText className="size-3.5 shrink-0" aria-hidden="true" />
          No preview available
        </div>
      )}
    </DetailCard>
  )
}
