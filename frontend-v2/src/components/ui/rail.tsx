import * as React from "react"
import {
  ChatTeardrop,
  GearSix,
  PencilLine,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import {
  APP_MODE_LABELS,
  APP_MODE_SHORTCUTS,
  APP_MODES,
  type AppMode,
} from "./app-mode"

export type { AppMode }

const MODE_ICONS: Record<AppMode, Icon> = {
  agents: UsersThree,
  converse: ChatTeardrop,
  studio: PencilLine,
}

/** 36px visual control with invisible padding to 44px touch target. */
const railIconButtonVariants = cva(
  "relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground outline-none transition-colors before:absolute before:-inset-1 before:content-[''] hover:bg-muted focus-visible:ring-focus-ring-width focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
)

type RailProps = {
  activeMode: AppMode
  onModeChange: (mode: AppMode) => void
  onOpenSettings?: () => void
  className?: string
}

function Rail({ activeMode, onModeChange, onOpenSettings, className }: RailProps) {
  const tabListRef = React.useRef<HTMLDivElement>(null)

  const focusModeTab = React.useCallback((mode: AppMode) => {
    const tab = tabListRef.current?.querySelector<HTMLElement>(
      `[data-mode="${mode}"]`,
    )
    tab?.focus()
  }, [])

  const handleModeKeyDown = React.useCallback(
    (e: React.KeyboardEvent, mode: AppMode) => {
      const index = APP_MODES.indexOf(mode)
      if (index === -1) return

      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault()
        const next = APP_MODES[(index + 1) % APP_MODES.length]
        onModeChange(next)
        focusModeTab(next)
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault()
        const prev = APP_MODES[(index - 1 + APP_MODES.length) % APP_MODES.length]
        onModeChange(prev)
        focusModeTab(prev)
      } else if (e.key === "Home") {
        e.preventDefault()
        onModeChange(APP_MODES[0])
        focusModeTab(APP_MODES[0])
      } else if (e.key === "End") {
        e.preventDefault()
        const last = APP_MODES[APP_MODES.length - 1]
        onModeChange(last)
        focusModeTab(last)
      }
    },
    [focusModeTab, onModeChange],
  )

  return (
    <TooltipProvider delayDuration={300}>
      <nav
        data-slot="rail"
        aria-label="Application modes"
        className={cn(
          "flex h-full w-12 shrink-0 flex-col border-r border-sidebar-border bg-sidebar",
          className,
        )}
      >
        <div
          ref={tabListRef}
          role="tablist"
          aria-orientation="vertical"
          aria-label="Modes"
          className="flex flex-col items-center gap-2 px-2 pt-2"
        >
          {APP_MODES.map((mode) => {
            const isActive = mode === activeMode
            const IconComponent = MODE_ICONS[mode]
            return (
              <Tooltip key={mode}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    data-slot="rail-mode-tab"
                    data-mode={mode}
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    className={cn(
                      railIconButtonVariants(),
                      isActive && "bg-transparent",
                    )}
                    onClick={() => onModeChange(mode)}
                    onKeyDown={(e) => handleModeKeyDown(e, mode)}
                  >
                    {isActive && (
                      <span
                        data-slot="rail-active-indicator"
                        className="absolute top-0 bottom-0 left-0 w-0.5 rounded-full bg-accent-fill"
                        aria-hidden
                      />
                    )}
                    <IconComponent
                      size={24}
                      weight={isActive ? "bold" : "regular"}
                      className={cn(
                        "relative z-10",
                        isActive ? "text-foreground" : "text-sidebar-foreground",
                      )}
                    />
                    <span className="sr-only">{APP_MODE_LABELS[mode]}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {APP_MODE_LABELS[mode]}{" "}
                  <span className="text-muted-foreground">
                    {APP_MODE_SHORTCUTS[mode]}
                  </span>
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>

        <div className="flex-1" aria-hidden />

        {onOpenSettings ? (
          <div className="flex justify-center px-2 pb-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-slot="rail-settings"
                  className={railIconButtonVariants()}
                  onClick={onOpenSettings}
                  aria-label="Settings"
                >
                  <GearSix size={24} weight="regular" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Settings</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </nav>
    </TooltipProvider>
  )
}

export { Rail, railIconButtonVariants, type RailProps }
