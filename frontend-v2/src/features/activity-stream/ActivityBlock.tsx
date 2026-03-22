import { useMemo, useState } from "react"

import { Brain } from "@phosphor-icons/react"

import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

import { ActivityBlockHeader } from "./ActivityBlockHeader"
import { ItemLine } from "./ItemLine"
import { ToolDetail } from "./ToolDetail"
import { ToolLine } from "./ToolLine"
import type { ActivityBlockData, ActivityItem, ToolItem } from "./types"

type ActivityBlockProps = {
  activity: ActivityBlockData
  expanded?: boolean
  defaultExpanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  defaultShowAllTools?: boolean
  defaultExpandedToolIds?: string[]
  showPendingText?: boolean
  depth?: number
  className?: string
}

function isToolItem(item: ActivityItem): item is ToolItem {
  return item.kind === "tool"
}

export function ActivityBlock({
  activity,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  defaultShowAllTools = false,
  defaultExpandedToolIds = [],
  showPendingText = true,
  depth = 0,
  className,
}: ActivityBlockProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded)
  const [showAllTools, setShowAllTools] = useState(defaultShowAllTools)
  const [expandedTools, setExpandedTools] = useState(() => new Set(defaultExpandedToolIds))
  const isControlled = typeof expanded === "boolean"
  const isExpanded = isControlled ? expanded : internalExpanded
  const isStreaming = Boolean(activity.isStreaming)

  const setExpanded = (nextExpanded: boolean) => {
    if (!isControlled) {
      setInternalExpanded(nextExpanded)
    }

    onExpandedChange?.(nextExpanded)
  }

  const toggleExpanded = (id: string) => {
    setExpandedTools((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const tools = useMemo(
    () => activity.items.filter((item): item is ToolItem => isToolItem(item)),
    [activity.items]
  )

  const hiddenToolCount = Math.max(tools.length - 3, 0)
  const visibleItems = useMemo(() => {
    if (showAllTools || hiddenToolCount === 0) {
      return activity.items
    }

    const firstVisibleTool = tools[hiddenToolCount]
    if (!firstVisibleTool) {
      return activity.items
    }

    const startIndex = activity.items.findIndex(
      (item) => item.kind === "tool" && item.id === firstVisibleTool.id
    )

    if (startIndex < 0) {
      return activity.items
    }

    return activity.items.slice(startIndex)
  }, [activity.items, hiddenToolCount, showAllTools, tools])

  const renderNestedActivity = (nested: ActivityBlockData, nestedDepth: number) => (
    <ActivityBlock
      activity={nested}
      depth={nestedDepth}
      defaultExpanded={nestedDepth <= 1}
      showPendingText
      className="mt-2"
    />
  )

  return (
    <div className={cn("space-y-2", depth > 0 ? "ml-4" : undefined, className)}>
      <Collapsible open={isExpanded} onOpenChange={setExpanded}>
        <Card
          variant={depth > 0 ? "outline" : "muted"}
          className="gap-0 overflow-hidden rounded-lg border-border/70 bg-card/85 py-0"
        >
          <ActivityBlockHeader
            items={activity.items}
            isStreaming={isStreaming}
            expanded={isExpanded}
          />

          <CollapsibleContent>
            {hiddenToolCount > 0 ? (
              <div className="relative h-px">
                <span className="absolute inset-x-0 top-0 h-px bg-border/70" />
                <button
                  type="button"
                  onClick={() => setShowAllTools(!showAllTools)}
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border border-border/70 bg-card px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                >
                  {showAllTools
                    ? "Collapse"
                    : `${hiddenToolCount} earlier ${hiddenToolCount === 1 ? "tool" : "tools"}...`}
                </button>
              </div>
            ) : null}

            {/* Tree-line guide — sits in the px-3 padding zone, no layout impact */}
            <div className="relative">
              <div className="pointer-events-none absolute bottom-2 left-5 top-0 w-px bg-border/50" />

              {visibleItems.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                visibleItems.map((item) => {
                  if (item.kind === "thinking") {
                    const isThinkingExpanded = expandedTools.has(item.id)
                    return (
                      <div key={item.id}>
                        <ItemLine
                          icon={Brain}
                          label="Thinking"
                          labelClassName="italic text-muted-foreground"
                          expanded={isThinkingExpanded}
                          onToggle={() => toggleExpanded(item.id)}
                        />
                        {isThinkingExpanded ? (
                          <div className="px-3 pb-2">
                            <p className="whitespace-pre-line text-sm italic text-muted-foreground">{item.text}</p>
                          </div>
                        ) : null}
                      </div>
                    )
                  }

                  if (item.kind === "text") {
                    return (
                      <div key={item.id} className="px-3 py-2">
                        <p className="text-sm text-foreground">{item.text}</p>
                      </div>
                    )
                  }

                  const isDetailExpanded = expandedTools.has(item.id)

                  return (
                    <div key={item.id}>
                      <ToolLine
                        tool={item}
                        expanded={isDetailExpanded}
                        onToggle={() => toggleExpanded(item.id)}
                      />
                      {isDetailExpanded ? (
                        <ToolDetail
                          tool={item}
                          depth={depth}
                          className="px-3 pb-2"
                          renderNestedActivity={renderNestedActivity}
                        />
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>

          </CollapsibleContent>
        </Card>
      </Collapsible>

      {showPendingText && activity.pendingText ? (
        <p className="px-3 text-sm text-foreground">{activity.pendingText}</p>
      ) : null}
    </div>
  )
}
