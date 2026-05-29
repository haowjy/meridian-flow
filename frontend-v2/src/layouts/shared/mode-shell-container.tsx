import * as React from "react"

import type { AppMode } from "@/components/ui/app-mode"
import { cn } from "@/lib/utils"

import {
  ModeShellActiveProvider,
  useShellVisibility,
} from "../app-shell/shell-visibility-context"
import { useFocusRestore } from "../app-shell/use-focus-restore"

type ModeShellContainerProps = {
  mode: AppMode
  children: React.ReactNode
  className?: string
}

function ModeShellContainer({ mode, children, className }: ModeShellContainerProps) {
  const { activeMode } = useShellVisibility()
  const isActive = activeMode === mode
  const containerRef = useFocusRestore(mode, isActive)

  return (
    <ModeShellActiveProvider active={isActive}>
      <div
        ref={containerRef}
        data-slot="mode-shell"
        data-mode={mode}
        data-active={isActive || undefined}
        aria-hidden={!isActive}
        inert={!isActive}
        className={cn(
          "absolute inset-0 flex min-h-0 flex-col overflow-hidden",
          isActive ? "block cv-auto" : "hidden cv-hidden",
          className,
        )}
      >
        {children}
      </div>
    </ModeShellActiveProvider>
  )
}

export { ModeShellContainer, type ModeShellContainerProps }
