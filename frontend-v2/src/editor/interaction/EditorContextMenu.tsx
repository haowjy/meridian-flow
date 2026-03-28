import type { EditorView } from "@codemirror/view"
import { useSyncExternalStore, type RefObject } from "react"

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover"

import { contextMenuBridge, type MenuElementType } from "./context-menu-bridge"
import { executeMenuAction } from "./menu-actions"

interface MenuItemDef {
  label: string
  action: string
  /** Keyboard shortcut hint displayed on the right side */
  shortcut?: string
}

/** Separator placeholder */
const SEPARATOR = "---"

type MenuEntry = MenuItemDef | typeof SEPARATOR

/**
 * Menu entries per element type, matching the design doc exactly:
 * - Link: Edit Link, Copy URL, Open in New Tab, separator, Show Raw
 * - Image: Edit Alt Text, Edit URL, View Full Size, separator, Show Raw
 * - Code Block: Edit Source, Copy Code, separator, Show Raw
 * - Mermaid: Edit Source, Export SVG, separator, Show Raw
 */
function getMenuEntries(type: MenuElementType): MenuEntry[] {
  switch (type) {
    case "link":
      return [
        { label: "Edit Link...", action: "edit-link" },
        { label: "Copy URL", action: "copy-url" },
        { label: "Open in New Tab", action: "open-link" },
        SEPARATOR,
        { label: "Show Raw", action: "show-raw" },
      ]
    case "image":
      return [
        { label: "Edit Alt Text...", action: "edit-alt" },
        { label: "Edit URL...", action: "edit-url" },
        { label: "View Full Size", action: "view-full-size" },
        SEPARATOR,
        { label: "Show Raw", action: "show-raw" },
      ]
    case "code-block":
      return [
        { label: "Edit Source", action: "edit-source" },
        { label: "Copy Code", action: "copy-code" },
        SEPARATOR,
        { label: "Show Raw", action: "show-raw" },
      ]
    case "mermaid":
      return [
        { label: "Edit Source", action: "edit-source" },
        { label: "Export SVG", action: "export-svg" },
        SEPARATOR,
        { label: "Show Raw", action: "show-raw" },
      ]
  }
}

/**
 * React context menu component for the editor. Uses Radix Popover (not
 * ContextMenu) because Radix ContextMenu expects to own the trigger element
 * via <ContextMenu.Trigger>, which conflicts with CM6 owning the DOM.
 *
 * Positioned at click coordinates via a zero-size fixed anchor.
 * Uses useSyncExternalStore to read from the ContextMenuBridge.
 */
export function EditorContextMenu({
  viewRef,
}: {
  viewRef: RefObject<EditorView | null>
}) {
  const menuState = useSyncExternalStore(
    contextMenuBridge.subscribe,
    contextMenuBridge.getSnapshot,
  )

  if (!menuState) return null

  const entries = getMenuEntries(menuState.type)

  function handleAction(action: string) {
    const view = viewRef.current
    if (!view) return
    executeMenuAction(view, action)
  }

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) contextMenuBridge.close()
      }}
    >
      <PopoverAnchor
        style={{
          position: "fixed",
          left: menuState.coords.x,
          top: menuState.coords.y,
          width: 0,
          height: 0,
          pointerEvents: "none",
        }}
      />
      <PopoverContent
        className="w-48 p-1"
        align="start"
        side="bottom"
        sideOffset={0}
        // Prevent Radix from stealing focus from the editor
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {entries.map((entry, i) => {
          if (entry === SEPARATOR) {
            return (
              <div
                key={`sep-${i}`}
                className="my-1 h-px bg-border"
              />
            )
          }
          return (
            <button
              key={entry.action}
              type="button"
              className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
              onPointerDown={(e) => {
                // Prevent focus loss from the editor
                e.preventDefault()
              }}
              onClick={() => handleAction(entry.action)}
            >
              <span>{entry.label}</span>
              {entry.shortcut && (
                <span className="ml-4 text-xs text-muted-foreground">
                  {entry.shortcut}
                </span>
              )}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
