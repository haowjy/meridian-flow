import * as React from "react"

import { PanelResizeHandle } from "@/components/ui/panel-resize-handle"
import { cn } from "@/lib/utils"

import { readPanelSize, writePanelSize } from "./panel-storage"

type ResizableSplitProps = {
  storageKey: string
  defaultPrimarySize: number
  minPrimary: number
  maxPrimary: number
  primary: React.ReactNode
  secondary: React.ReactNode
  /** When false, secondary pane stacks/hides per responsive rules in the parent. */
  enabled?: boolean
  className?: string
}

function ResizableSplit({
  storageKey,
  defaultPrimarySize,
  minPrimary,
  maxPrimary,
  primary,
  secondary,
  enabled = true,
  className,
}: ResizableSplitProps) {
  const [primarySize, setPrimarySize] = React.useState(() =>
    readPanelSize(storageKey, defaultPrimarySize),
  )

  const handleCommit = React.useCallback(
    (value: number) => {
      writePanelSize(storageKey, value)
    },
    [storageKey],
  )

  if (!enabled) {
    return (
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
        <div className="min-h-0 min-w-0 flex-1">{primary}</div>
      </div>
    )
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1", className)}>
      <div
        className="min-h-0 min-w-0 shrink-0 overflow-hidden"
        style={{ width: primarySize }}
      >
        {primary}
      </div>
      <PanelResizeHandle
        value={primarySize}
        min={minPrimary}
        max={maxPrimary}
        defaultValue={defaultPrimarySize}
        onResize={setPrimarySize}
        onResizeCommit={handleCommit}
        onReset={() => setPrimarySize(defaultPrimarySize)}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{secondary}</div>
    </div>
  )
}

export { ResizableSplit, type ResizableSplitProps }
