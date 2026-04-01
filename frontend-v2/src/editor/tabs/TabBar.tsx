import { FileText, X } from "@phosphor-icons/react"
import { useCallback, useRef } from "react"

import { cn } from "@/lib/utils"

import type { OpenDoc } from "../session/view-controller"

export interface TabBarProps {
  tabs: OpenDoc[]
  activeTabId: string | null
  onSwitch: (documentId: string) => void
  onClose: (documentId: string) => void
  className?: string
}

/**
 * Horizontal tab strip above the editor area.
 *
 * Compact pills with file icon, truncated name, close button, and
 * modified indicator dot. Active tab has accent fill. Overflow
 * scrolls horizontally. Keyboard navigation: ArrowLeft/Right between
 * tabs, Ctrl+W closes active tab.
 */
export function TabBar({
  tabs,
  activeTabId,
  onSwitch,
  onClose,
  className,
}: TabBarProps) {
  const tabListRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = tabs.findIndex((t) => t.id === activeTabId)
      if (currentIndex === -1) return

      if (e.key === "ArrowLeft") {
        e.preventDefault()
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1
        onSwitch(tabs[prevIndex].id)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        const nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0
        onSwitch(tabs[nextIndex].id)
      } else if (e.key === "w" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (activeTabId) {
          onClose(activeTabId)
        }
      }
    },
    [tabs, activeTabId, onSwitch, onClose],
  )

  if (tabs.length === 0) return null

  return (
    <div
      ref={tabListRef}
      role="tablist"
      aria-label="Open documents"
      className={cn(
        "flex items-center gap-1 border-b border-border/80 px-2 h-9",
        "overflow-x-auto scrollbar-none",
        className,
      )}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSwitch(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onSwitch(tab.id)
              }
            }}
            className={cn(
              "group flex cursor-pointer items-center gap-1.5 px-3 h-7 rounded-md text-xs font-medium",
              "max-w-[180px] shrink-0 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
              isActive
                ? "bg-accent-fill text-white"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <FileText size={14} className="shrink-0" />
            <span className="truncate">
              {tab.isModified && (
                <span
                  className={cn(
                    "mr-1 inline-block",
                    isActive ? "text-white" : "text-accent-fill",
                  )}
                  aria-label="Modified"
                >
                  {"\u25CF"}
                </span>
              )}
              {tab.name}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
              className={cn(
                "shrink-0 ml-1 rounded-sm p-0.5 transition-opacity",
                "hover:bg-white/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                isActive
                  ? "opacity-70 hover:opacity-100"
                  : "opacity-0 group-hover:opacity-70 group-hover:hover:opacity-100",
              )}
              aria-label={`Close ${tab.name}`}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
