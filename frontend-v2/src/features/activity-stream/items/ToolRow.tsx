import { ArrowSquareOut, Check, CircleNotch, X } from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { ItemLine } from "../ItemLine"
import { ToolDetail } from "../ToolDetail"
import {
  getToolCategory,
  getToolIcon,
  getToolLineTitle,
  getToolStatusLabel,
  getToolStatusVariant,
} from "../tool-utils"
import type { ToolItem } from "../types"

type ToolRowProps = {
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

export function ToolRow({ tool, expanded, onToggle, onViewFile, className }: ToolRowProps) {
  const category = getToolCategory(tool)
  const Icon = getToolIcon(category)
  const title = getToolLineTitle(tool)
  const statusText = getToolStatusLabel(tool.status)
  const statusVariant = getToolStatusVariant(tool.status)
  const showViewFile = category === "read" && tool.status === "done"

  return (
    <ItemLine
      icon={Icon}
      label={title}
      expanded={expanded}
      onToggle={onToggle}
      className={className}
      detail={expanded ? <ToolDetail tool={tool} /> : undefined}
    >
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
    </ItemLine>
  )
}
