import { Brain, CaretDown, CaretRight, Check, CircleNotch } from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

import { RotatingText } from "./RotatingText"
import { STREAMING_STATUS_MESSAGES, getActivitySummary } from "./tool-utils"
import type { ActivityItem } from "./types"

type ActivityBlockHeaderProps = {
  items: ActivityItem[]
  isStreaming: boolean
  expanded: boolean
  onToggle: () => void
  contentId: string
  className?: string
}

export function ActivityBlockHeader({
  items,
  isStreaming,
  expanded,
  onToggle,
  contentId,
  className,
}: ActivityBlockHeaderProps) {
  const summary = getActivitySummary(items)

  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={contentId}
      aria-label={expanded ? "Collapse activity details" : "Expand activity details"}
      onClick={onToggle}
      className={cn(
        "flex min-h-10 w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/40",
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Brain className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 font-medium text-foreground">ActivityBlock:</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {isStreaming ? (
            <RotatingText messages={STREAMING_STATUS_MESSAGES} className="italic" />
          ) : (
            summary
          )}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="secondary" className="h-5 px-2 text-[11px]">
          {isStreaming ? (
            <>
              <CircleNotch className="size-3 animate-spin" aria-hidden="true" />
              live
            </>
          ) : (
            <>
              <Check className="size-3" aria-hidden="true" />
              done
            </>
          )}
        </Badge>
        {expanded ? (
          <CaretDown className="size-4 text-muted-foreground" aria-hidden="true" />
        ) : (
          <CaretRight className="size-4 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
    </button>
  )
}
