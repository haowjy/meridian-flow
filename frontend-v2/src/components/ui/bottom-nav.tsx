import * as React from "react"
import {
  ChatTeardrop,
  DotsThree,
  PencilLine,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

import {
  APP_MODE_LABELS,
  APP_MODES,
  type AppMode,
} from "./app-mode"

export type BottomNavTab = AppMode | "more"

const TAB_ICONS: Record<BottomNavTab, Icon> = {
  agents: UsersThree,
  converse: ChatTeardrop,
  studio: PencilLine,
  more: DotsThree,
}

const TAB_LABELS: Record<BottomNavTab, string> = {
  ...APP_MODE_LABELS,
  more: "More",
}

const bottomNavTabVariants = cva(
  "relative flex min-h-touch-target flex-1 flex-col items-center justify-center gap-0.5 px-1 pt-1 text-xs outline-none transition-colors focus-visible:ring-focus-ring-width focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
)

type BottomNavProps = {
  activeTab: BottomNavTab
  onTabChange: (tab: BottomNavTab) => void
  /** Shows a destructive dot on the More tab (e.g. disconnected). */
  showMoreAlert?: boolean
  className?: string
}

const NAV_TABS: BottomNavTab[] = [...APP_MODES, "more"]

function BottomNav({
  activeTab,
  onTabChange,
  showMoreAlert = false,
  className,
}: BottomNavProps) {
  const tabListRef = React.useRef<HTMLDivElement>(null)

  const focusTab = React.useCallback((tab: BottomNavTab) => {
    const el = tabListRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)
    el?.focus()
  }, [])

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent, tab: BottomNavTab) => {
      const index = NAV_TABS.indexOf(tab)
      if (index === -1) return

      if (e.key === "ArrowRight") {
        e.preventDefault()
        const next = NAV_TABS[(index + 1) % NAV_TABS.length]
        onTabChange(next)
        focusTab(next)
      } else if (e.key === "ArrowLeft") {
        e.preventDefault()
        const prev = NAV_TABS[(index - 1 + NAV_TABS.length) % NAV_TABS.length]
        onTabChange(prev)
        focusTab(prev)
      }
    },
    [focusTab, onTabChange],
  )

  return (
    <nav
      data-slot="bottom-nav"
      aria-label="Application navigation"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t border-sidebar-border bg-sidebar",
        "pb-[env(safe-area-inset-bottom)]",
        className,
      )}
    >
      <div
        ref={tabListRef}
        role="tablist"
        aria-label="Modes"
        className="flex h-bottom-nav-height items-stretch"
      >
        {NAV_TABS.map((tab) => {
          const isActive = tab === activeTab
          const IconComponent = TAB_ICONS[tab]
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              data-slot="bottom-nav-tab"
              data-tab={tab}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={cn(
                bottomNavTabVariants(),
                isActive ? "text-accent-text" : "text-muted-foreground",
              )}
              onClick={() => onTabChange(tab)}
              onKeyDown={(e) => handleKeyDown(e, tab)}
            >
              {isActive && (
                <span
                  data-slot="bottom-nav-active-indicator"
                  className="absolute top-0 right-4 left-4 h-0.5 rounded-full bg-accent-fill"
                  aria-hidden
                />
              )}
              <span className="relative">
                <IconComponent
                  size={24}
                  weight={isActive ? "bold" : "regular"}
                  className={isActive ? "text-accent-text" : undefined}
                />
                {tab === "more" && showMoreAlert ? (
                  <span
                    data-slot="bottom-nav-more-alert"
                    className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-destructive"
                    aria-label="Connection issue"
                  />
                ) : null}
              </span>
              <span className={isActive ? "font-medium text-accent-text" : ""}>
                {TAB_LABELS[tab]}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

export { BottomNav, bottomNavTabVariants, type BottomNavProps }
