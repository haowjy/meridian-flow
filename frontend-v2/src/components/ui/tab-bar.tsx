import * as React from "react"
import { CaretRight, PushPin, X } from "@phosphor-icons/react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"

export type TabBarTab = {
  id: string
  label: string
  isDirty?: boolean
  /** Preview tabs use italic title; only one preview slot at a time in real shells. */
  isPreview?: boolean
  isPinned?: boolean
}

const tabItemVariants = cva(
  "group/tab relative flex h-7 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 rounded-none px-padding-compact text-sm font-medium outline-none transition-colors focus-visible:ring-focus-ring-width focus-visible:ring-ring/50",
  {
    variants: {
      state: {
        activePersistent:
          "border-b-2 border-accent-fill bg-card text-foreground",
        activePreview:
          "border-b-2 border-accent-fill bg-card text-foreground italic",
        inactivePersistent: "text-muted-foreground",
        inactivePreview: "text-muted-foreground italic",
        inactiveHover: "bg-muted/50 text-foreground",
      },
    },
    defaultVariants: {
      state: "inactivePersistent",
    },
  },
)

function resolveTabState(
  tab: TabBarTab,
  isActive: boolean,
  isHovered: boolean,
): VariantProps<typeof tabItemVariants>["state"] {
  if (isActive) {
    return tab.isPreview ? "activePreview" : "activePersistent"
  }
  if (isHovered) return "inactiveHover"
  return tab.isPreview ? "inactivePreview" : "inactivePersistent"
}

type TabBarProps = {
  tabs: TabBarTab[]
  activeTabId: string | null
  onTabActivate: (tabId: string) => void
  onTabClose: (tabId: string) => void
  onTabPin?: (tabId: string) => void
  onTabPromote?: (tabId: string) => void
  /** When true, shows overflow chevron at the right edge. */
  showOverflowIndicator?: boolean
  className?: string
}

function TabBar({
  tabs,
  activeTabId,
  onTabActivate,
  onTabClose,
  onTabPin,
  onTabPromote,
  showOverflowIndicator = false,
  className,
}: TabBarProps) {
  const [hoveredTabId, setHoveredTabId] = React.useState<string | null>(null)
  const tabListRef = React.useRef<HTMLDivElement>(null)

  const handleListKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = tabs.findIndex((t) => t.id === activeTabId)
      if (currentIndex === -1) return

      if (e.key === "ArrowLeft") {
        e.preventDefault()
        const prev = tabs[currentIndex > 0 ? currentIndex - 1 : tabs.length - 1]
        onTabActivate(prev.id)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        const next =
          tabs[currentIndex < tabs.length - 1 ? currentIndex + 1 : 0]
        onTabActivate(next.id)
      }
    },
    [activeTabId, onTabActivate, tabs],
  )

  if (tabs.length === 0) return null

  return (
    <div
      data-slot="tab-bar"
      className={cn(
        "relative flex h-9 shrink-0 items-stretch border-b border-border bg-background",
        className,
      )}
    >
      <ScrollArea
        orientation="horizontal"
        className="min-w-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:hidden"
      >
        <div
          ref={tabListRef}
          role="tablist"
          aria-label="Open documents"
          className="flex h-9 items-stretch"
          onKeyDown={handleListKeyDown}
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            const isHovered = tab.id === hoveredTabId
            const showClose = isActive || isHovered
            const showPin = tab.isPreview && (isHovered || isActive)

            return (
              <div
                key={tab.id}
                role="tab"
                data-slot="tab-bar-tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className={tabItemVariants({
                  state: resolveTabState(tab, isActive, isHovered),
                })}
                onClick={() => onTabActivate(tab.id)}
                onMouseEnter={() => setHoveredTabId(tab.id)}
                onMouseLeave={() =>
                  setHoveredTabId((id) => (id === tab.id ? null : id))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    onTabActivate(tab.id)
                  }
                }}
                onDoubleClick={() => {
                  if (tab.isPreview) onTabPromote?.(tab.id)
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    onTabClose(tab.id)
                  }
                }}
              >
                {tab.isDirty && !tab.isPreview ? (
                  <span
                    data-slot="tab-bar-dirty-dot"
                    className="size-1.5 shrink-0 rounded-full bg-accent-fill"
                    aria-label="Unsaved changes"
                  />
                ) : null}
                <span className="truncate">{tab.label}</span>
                {showPin ? (
                  <button
                    type="button"
                    data-slot="tab-bar-pin"
                    className="relative flex size-3.5 shrink-0 items-center justify-center rounded-sm opacity-70 outline-none before:absolute before:-inset-2.5 before:content-[''] hover:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label={`Pin ${tab.label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onTabPin?.(tab.id)
                      onTabPromote?.(tab.id)
                    }}
                  >
                    <PushPin size={14} />
                  </button>
                ) : null}
                {showClose ? (
                  <button
                    type="button"
                    data-slot="tab-bar-close"
                    className="relative flex size-3.5 shrink-0 items-center justify-center rounded-sm opacity-70 outline-none before:absolute before:-inset-2.5 before:content-[''] hover:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label={`Close ${tab.label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onTabClose(tab.id)
                    }}
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      </ScrollArea>

      {showOverflowIndicator ? (
        <div
          data-slot="tab-bar-overflow"
          className="pointer-events-none flex w-8 shrink-0 items-center justify-center border-l border-border bg-background text-muted-foreground"
          aria-hidden
        >
          <CaretRight size={14} />
        </div>
      ) : null}
    </div>
  )
}

export { TabBar, tabItemVariants, type TabBarProps }
