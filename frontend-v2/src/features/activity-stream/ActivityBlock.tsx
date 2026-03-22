import { useId, useMemo, useState } from "react"

import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

import { ActivityBlockHeader } from "./ActivityBlockHeader"
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
  const contentId = useId()
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
          className="overflow-hidden border-border/70 bg-card/85"
        >
          <ActivityBlockHeader
            items={activity.items}
            isStreaming={isStreaming}
            expanded={isExpanded}
            onToggle={() => setExpanded(!isExpanded)}
            contentId={contentId}
          />

          <CollapsibleContent id={contentId} className="border-t border-border/70 p-3">
            {hiddenToolCount > 0 && !showAllTools ? (
              <button
                type="button"
                onClick={() => setShowAllTools(true)}
                className="mb-2 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                ({hiddenToolCount} more...)
              </button>
            ) : null}

            <div className="space-y-2">
              {visibleItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                visibleItems.map((item, index) => {
                  if (item.kind === "thinking") {
                    return (
                      <div key={item.id} className="space-y-2">
                        {index > 0 ? <Separator /> : null}
                        <p className="font-editor text-sm italic text-muted-foreground">{item.text}</p>
                      </div>
                    )
                  }

                  const isDetailExpanded = expandedTools.has(item.id)

                  return (
                    <div key={item.id} className="space-y-1.5">
                      {index > 0 ? <Separator /> : null}
                      <ToolLine
                        tool={item}
                        expanded={isDetailExpanded}
                        onToggle={() => {
                          setExpandedTools((current) => {
                            const next = new Set(current)
                            if (next.has(item.id)) {
                              next.delete(item.id)
                            } else {
                              next.add(item.id)
                            }
                            return next
                          })
                        }}
                      />
                      {isDetailExpanded ? (
                        <ToolDetail
                          tool={item}
                          depth={depth}
                          className="pl-2"
                          renderNestedActivity={renderNestedActivity}
                        />
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>

            {isStreaming && activity.pendingText ? (
              <p className="mt-3 border-t border-border/60 pt-3 font-editor text-sm italic text-muted-foreground">
                {activity.pendingText}
              </p>
            ) : null}
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {!isExpanded && showPendingText && activity.pendingText ? (
        <p className="px-1 font-editor text-base leading-relaxed text-foreground">{activity.pendingText}</p>
      ) : null}
    </div>
  )
}
