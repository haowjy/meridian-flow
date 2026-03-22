import { ArrowSquareOut, CaretDown, CaretRight, Check, CircleNotch, X } from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
        "flex min-h-10 w-full items-center justify-between px-3 py-2",
        className
      )}
    >
      <Button
        variant="ghost"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} detail for ${title}`}
        className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-none px-0 py-0 text-sm font-normal hover:bg-transparent hover:opacity-70"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate text-foreground">{title}</span>
      </Button>

      <span className="ml-2 flex shrink-0 items-center gap-2">
        {showViewFile ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              onViewFile?.()
            }}
            aria-label={`View file ${title}`}
            className="h-auto gap-1 rounded-none px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ArrowSquareOut className="size-3" aria-hidden="true" />
            View file
          </Button>
        ) : null}
        <Badge variant={statusVariant} className="h-5 px-2 text-[11px] font-medium">
          <ToolStatusGlyph status={tool.status} />
          {statusText}
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-hidden="true"
          tabIndex={-1}
          className="size-5 rounded-none text-muted-foreground hover:text-foreground"
        >
          {expanded ? (
            <CaretDown className="size-3.5" />
          ) : (
            <CaretRight className="size-3.5" />
          )}
        </Button>
      </span>
    </div>
  )
}
