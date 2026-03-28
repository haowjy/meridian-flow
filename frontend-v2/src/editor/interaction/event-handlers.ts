import { syntaxTree } from "@codemirror/language"
import type { Extension, StateEffect } from "@codemirror/state"
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"

import { getAtomicWidgetRanges, nearestWidgetAtPos } from "../decorations/atomic-ranges"
import { concealElement, revealElement, revealState } from "../decorations/reveal-state"
import { contextMenuBridge, type MenuElementType } from "./context-menu-bridge"

/**
 * Identify the element type and extract metadata at a document position.
 * Used by the context menu handler and Shift+F10 keyboard shortcut.
 */
function getElementTypeAtPos(
  state: import("@codemirror/state").EditorState,
  pos: number,
): { type: MenuElementType; meta: Record<string, string> } | null {
  const tree = syntaxTree(state)
  const node = tree.resolveInner(pos, 1)

  // Walk up the tree to find a known element type
  let current: typeof node | null = node
  while (current) {
    switch (current.name) {
      case "Link": {
        const urlNode = current.getChild("URL")
        const marks = current.getChildren("LinkMark")
        const href = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : ""
        const text = marks.length >= 2
          ? state.doc.sliceString(marks[0].to, marks[1].from)
          : ""
        return { type: "link", meta: { href, text } }
      }
      case "Image": {
        const urlNode = current.getChild("URL")
        const marks = current.getChildren("LinkMark")
        const src = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : ""
        const alt = marks.length >= 2
          ? state.doc.sliceString(marks[0].to, marks[1].from)
          : ""
        return { type: "image", meta: { src, alt } }
      }
      case "FencedCode": {
        const codeInfo = current.getChild("CodeInfo")
        const language = codeInfo
          ? state.doc.sliceString(codeInfo.from, codeInfo.to).trim()
          : ""
        if (language.toLowerCase() === "mermaid") {
          return { type: "mermaid", meta: { language } }
        }
        return { type: "code-block", meta: { language } }
      }
    }
    current = current.parent
  }

  return null
}

// Re-export for use by menu-actions.ts
export { getElementTypeAtPos }

/**
 * Unified domEventHandlers for all embedded object interactions.
 * Handles: contextmenu, dblclick, mousedown (Cmd+Click), keydown
 * (Escape, Enter/Space, Shift+F10), touchstart (long-press), touchend (double-tap).
 */
function createInteractionHandlers(): Extension {
  return EditorView.domEventHandlers({
    contextmenu(event: MouseEvent, view: EditorView) {
      const target = event.target as HTMLElement
      // HR widgets use .md-hr-wrapper and have no context menu
      if (target.closest(".md-hr-wrapper")) return false
      // Check for atomic widgets (.md-widget-wrapper) OR link mark decorations (.md-link).
      // Links are not widgets but still get a custom context menu.
      const widget = target.closest(".md-widget-wrapper") || target.closest(".md-link")
      if (!widget) return false

      event.preventDefault()
      const pos = view.posAtDOM(widget)
      const elementType = getElementTypeAtPos(view.state, pos)
      if (!elementType) return false

      contextMenuBridge.open({
        type: elementType.type,
        pos,
        coords: { x: event.clientX, y: event.clientY },
        meta: elementType.meta,
      })
      return true
    },

    dblclick(event: MouseEvent, view: EditorView) {
      const target = event.target as HTMLElement
      // Links: double-click enters edit mode
      const link = target.closest(".md-link")
      if (link) {
        event.preventDefault()
        const pos = view.posAtDOM(link)
        const node = syntaxTree(view.state).resolveInner(pos, 1)
        // Walk up to find the Link node
        let linkNode = node
        while (linkNode.parent && linkNode.name !== "Link") {
          linkNode = linkNode.parent
        }
        view.dispatch({
          effects: revealElement.of({ from: linkNode.from, to: linkNode.to }),
          selection: { anchor: linkNode.from + 1 },
        })
        return true
      }
      // Widgets: double-click enters edit mode
      const widget = target.closest(".md-widget-wrapper")
      if (widget) {
        event.preventDefault()
        const pos = view.posAtDOM(widget)
        const node = syntaxTree(view.state).resolveInner(pos, 1)
        // Walk up to find the block-level node (FencedCode, Image, etc.)
        let blockNode = node
        while (blockNode.parent && blockNode.name !== "FencedCode" && blockNode.name !== "Image") {
          blockNode = blockNode.parent
        }
        view.dispatch({
          effects: revealElement.of({ from: blockNode.from, to: blockNode.to }),
          selection: { anchor: blockNode.from + 1 },
        })
        return true
      }
      return false
    },

    mousedown(event: MouseEvent) {
      // Cmd/Ctrl+Click on links: handled by linkDecorations ViewPlugin
      // (see links.ts eventHandlers). This handler is for images only.
      if (event.metaKey || event.ctrlKey) {
        const target = event.target as HTMLElement
        const image = target.closest(".md-image-wrapper img")
        if (image) {
          event.preventDefault()
          // Open full-size image in new tab
          const src = (image as HTMLImageElement).src
          if (src) {
            window.open(src, "_blank", "noopener,noreferrer")
          }
          return true
        }
      }
      return false
    },

    keydown(event: KeyboardEvent, view: EditorView) {
      // Shift+F10: keyboard equivalent of right-click
      if (event.key === "F10" && event.shiftKey) {
        const pos = view.state.selection.main.head
        const widget = nearestWidgetAtPos(view.state, pos, getAtomicWidgetRanges(view))
        if (!widget) return false
        const coords = view.coordsAtPos(pos)
        if (!coords) return false
        event.preventDefault()
        const elementType = getElementTypeAtPos(view.state, widget.from)
        if (!elementType) return false
        contextMenuBridge.open({
          type: elementType.type,
          pos: widget.from,
          coords: { x: coords.left, y: coords.bottom },
          meta: elementType.meta,
        })
        return true
      }
      // Escape: exit edit mode (re-render as widget)
      if (event.key === "Escape") {
        // Close context menu first if open
        if (contextMenuBridge.getState()) {
          contextMenuBridge.close()
          event.preventDefault()
          return true
        }
        const revealed = view.state.field(revealState)
        if (revealed.size === 0) return false
        event.preventDefault()
        // Conceal all currently revealed elements and move cursor after
        // the last revealed element so it doesn't immediately re-reveal.
        const effects: StateEffect<{ from: number; to: number }>[] = []
        let maxTo = 0
        for (const key of revealed) {
          const [from, to] = key.split("-").map(Number)
          effects.push(concealElement.of({ from, to }))
          if (to > maxTo) maxTo = to
        }
        view.dispatch({
          effects,
          selection: { anchor: Math.min(maxTo, view.state.doc.length) },
        })
        return true
      }
      // Enter/Space when cursor is adjacent to an ATOMIC WIDGET: enter edit mode.
      // Links are NOT targeted here -- they are mark decorations with navigable
      // text, not atomic widgets. nearestWidgetAtPos only finds .md-widget-wrapper.
      // HR is also excluded because nearestWidgetAtPos skips .md-hr-wrapper.
      if ((event.key === "Enter" || event.key === " ") && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        const pos = view.state.selection.main.head
        const widget = nearestWidgetAtPos(view.state, pos, getAtomicWidgetRanges(view))
        if (!widget) return false
        event.preventDefault()
        const node = syntaxTree(view.state).resolveInner(widget.from, 1)
        // Walk up to find block-level node
        let blockNode = node
        while (blockNode.parent && blockNode.name !== "FencedCode" && blockNode.name !== "Image") {
          blockNode = blockNode.parent
        }
        view.dispatch({
          effects: revealElement.of({ from: blockNode.from, to: blockNode.to }),
          selection: { anchor: blockNode.from + 1 },
        })
        return true
      }
      return false
    },

    // Long-press for touch devices (300ms)
    touchstart(event: TouchEvent, view: EditorView) {
      const target = event.target as HTMLElement
      const widget = target.closest(".md-widget-wrapper") || target.closest(".md-link")
      if (!widget) return false

      const touch = event.touches[0]
      const startX = touch.clientX
      const startY = touch.clientY
      const longPressTimer = setTimeout(() => {
        const pos = view.posAtDOM(widget)
        const elementType = getElementTypeAtPos(view.state, pos)
        if (!elementType) return
        contextMenuBridge.open({
          type: elementType.type,
          pos,
          coords: { x: startX, y: startY },
          meta: elementType.meta,
        })
      }, 300)

      // Cancel on touchmove or touchend (before timer fires)
      const cancel = () => {
        clearTimeout(longPressTimer)
        widget.removeEventListener("touchmove", cancel)
        widget.removeEventListener("touchend", cancel)
      }
      widget.addEventListener("touchmove", cancel, { once: true })
      widget.addEventListener("touchend", cancel, { once: true })
      return false
    },

    // Double-tap detection for touch devices (Show Raw).
    // CM6 doesn't have a native "doubletap" event, so we track tap timing
    // in touchend to detect double-taps on widgets.
    touchend: (() => {
      let lastTapTime = 0
      let lastTapWidget: Element | null = null
      return function (event: TouchEvent, view: EditorView) {
        const target = event.target as HTMLElement
        const widget = target.closest(".md-widget-wrapper") || target.closest(".md-link")
        if (!widget) {
          lastTapTime = 0
          lastTapWidget = null
          return false
        }

        const now = Date.now()
        if (lastTapWidget === widget && now - lastTapTime < 400) {
          // Double-tap detected -- enter edit mode (Show Raw)
          const pos = view.posAtDOM(widget)
          const node = syntaxTree(view.state).resolveInner(pos, 1)
          // Walk up to find the element node
          let elementNode = node
          while (
            elementNode.parent &&
            elementNode.name !== "FencedCode" &&
            elementNode.name !== "Image" &&
            elementNode.name !== "Link"
          ) {
            elementNode = elementNode.parent
          }
          view.dispatch({
            effects: revealElement.of({ from: elementNode.from, to: elementNode.to }),
            selection: { anchor: elementNode.from + 1 },
          })
          lastTapTime = 0
          lastTapWidget = null
          return true
        }
        lastTapTime = now
        lastTapWidget = widget
        return false
      }
    })(),
  })
}

/**
 * ViewPlugin that tracks ChangeDesc for the context menu bridge.
 * While the menu is open, accumulated changes allow position mapping.
 */
const contextMenuTracker = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (update.docChanged && contextMenuBridge.getState()) {
        contextMenuBridge.trackChanges(update.changes)
      }
    }
  },
)

/**
 * Extension that provides all interaction handlers and the context menu
 * ChangeDesc tracker. Include in the editor extension stack.
 */
export function interactionHandlers(): Extension[] {
  return [createInteractionHandlers(), contextMenuTracker]
}
