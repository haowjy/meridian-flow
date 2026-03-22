import { ArrowSquareOut, CaretDown, CaretRight, Check, CircleNotch, X } from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

import {
  getToolCategory,
  getToolIcon,
  getToolLineTitle,
  getToolStatusLabel,
  getToolStatusVariant,
} from "./tool-utils"
import type { ToolItem } from "./types"

type ToolLineProps = {
  tool: ToolItem
  expanded: boolean
  onToggle: () => void
  onViewFile?: () => void
  className?: string
}

function ToolStatusGlyph({ status }: Pick<ToolItem, "status">) {
  if (status === "done") {
    return <Check className="size-3" aria-hidden="true" />
  }

  if (status === "error") {
    return <X className="size-3" aria-hidden="true" />
  }

  return (
    <CircleNotch
      className={cn("size-3", status === "running" ? "animate-spin" : undefined)}
      aria-hidden="true"
    />
  )
}

export function ToolLine({ tool, expanded, onToggle, onViewFile, className }: ToolLineProps) {
  const category = getToolCategory(tool)
  const Icon = getToolIcon(category)
  const title = getToolLineTitle(tool)
  const statusText = getToolStatusLabel(tool.status)
  const statusVariant = getToolStatusVariant(tool.status)
  const showViewFile = category === "read" && tool.status === "done"

  return (
    <div
      className={cn(
        "flex w-full items-center justify-between rounded-md px-2 py-1.5",
        className
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} detail for ${title}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm hover:opacity-70 transition-opacity"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate text-foreground">{title}</span>
      </button>

      <span className="ml-2 flex shrink-0 items-center gap-2">
        {showViewFile ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onViewFile?.()
            }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`View file ${title}`}
          >
            <ArrowSquareOut className="size-3" aria-hidden="true" />
            View file
          </button>
        ) : null}
        <Badge variant={statusVariant} className="h-5 px-2 text-[11px] font-medium">
          <ToolStatusGlyph status={tool.status} />
          {statusText}
        </Badge>
        <button
          type="button"
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-hidden="true"
          tabIndex={-1}
        >
          {expanded ? (
            <CaretDown className="size-3.5" />
          ) : (
            <CaretRight className="size-3.5" />
          )}
        </button>
      </span>
    </div>
  )
}
