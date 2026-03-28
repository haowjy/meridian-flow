import { syntaxTree } from "@codemirror/language"
import type { EditorView } from "@codemirror/view"

import { revealElement } from "../decorations/reveal-state"
import { safeExternalUrl } from "../url-validation"
import { contextMenuBridge, type MenuElementType } from "./context-menu-bridge"

/**
 * Verify that the node at the mapped position is still the expected type.
 * A collaborator may have deleted or changed the element while the menu was open.
 */
function isExpectedElementType(
  nodeName: string,
  expectedType: MenuElementType,
): boolean {
  switch (expectedType) {
    case "link":
      return nodeName === "Link"
    case "image":
      return nodeName === "Image"
    case "code-block":
      return nodeName === "FencedCode"
    case "mermaid":
      return nodeName === "FencedCode"
    default:
      return false
  }
}

/**
 * Walk up the syntax tree from a position to find a node of the expected type.
 */
function findExpectedNode(
  state: import("@codemirror/state").EditorState,
  pos: number,
  expectedType: MenuElementType,
): import("@lezer/common").SyntaxNode | null {
  const tree = syntaxTree(state)
  let node = tree.resolveInner(pos, 1)
  while (node) {
    if (isExpectedElementType(node.name, expectedType)) {
      return node
    }
    if (!node.parent) break
    node = node.parent
  }
  return null
}

/**
 * Re-read current metadata from the syntax tree at the mapped position.
 * NEVER trust the bridged meta -- a collaborator may have changed the URL
 * or content while the menu was open.
 */
function extractFreshMeta(
  state: import("@codemirror/state").EditorState,
  node: import("@lezer/common").SyntaxNode,
): Record<string, string> {
  switch (node.name) {
    case "Link": {
      const urlNode = node.getChild("URL")
      const marks = node.getChildren("LinkMark")
      return {
        href: urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : "",
        text: marks.length >= 2 ? state.doc.sliceString(marks[0].to, marks[1].from) : "",
      }
    }
    case "Image": {
      const urlNode = node.getChild("URL")
      const marks = node.getChildren("LinkMark")
      return {
        src: urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : "",
        alt: marks.length >= 2 ? state.doc.sliceString(marks[0].to, marks[1].from) : "",
      }
    }
    case "FencedCode": {
      const codeInfo = node.getChild("CodeInfo")
      const language = codeInfo ? state.doc.sliceString(codeInfo.from, codeInfo.to).trim() : ""
      // Extract code content between fences
      const codeMark = node.getChild("CodeMark")
      const lastChild = node.lastChild
      let code = ""
      if (codeMark && lastChild) {
        const openLine = state.doc.lineAt(codeMark.from)
        const closeLine = state.doc.lineAt(lastChild.from)
        if (openLine.number + 1 <= closeLine.number - 1) {
          const contentStart = state.doc.line(openLine.number + 1).from
          const contentEnd = state.doc.line(closeLine.number - 1).to
          code = state.doc.sliceString(contentStart, contentEnd)
        }
      }
      return { language, code }
    }
    default:
      return {}
  }
}

/**
 * Enter "Show Raw" mode: dispatch revealElement effect and place cursor inside.
 */
function showRaw(view: EditorView, node: import("@lezer/common").SyntaxNode): void {
  view.dispatch({
    effects: revealElement.of({ from: node.from, to: node.to }),
    selection: { anchor: node.from + 1 },
  })
  view.focus()
}

/**
 * Execute a context menu action. Re-validates the element at the mapped
 * position before executing -- handles the case where remote Yjs edits
 * shifted or deleted the element while the menu was open.
 */
export function executeMenuAction(
  view: EditorView,
  action: string,
): void {
  const menuState = contextMenuBridge.getState()
  if (!menuState) return

  const mappedPos = contextMenuBridge.getMappedPos(view.state.doc.length)
  const node = findExpectedNode(view.state, mappedPos, menuState.type)

  if (!node) {
    // Element was deleted or changed type -- dismiss menu silently
    contextMenuBridge.close()
    return
  }

  // Re-read current metadata from the syntax tree
  const meta = extractFreshMeta(view.state, node)

  switch (action) {
    case "show-raw": {
      showRaw(view, node)
      break
    }

    case "open-link": {
      const safe = safeExternalUrl(meta.href ?? "")
      if (safe) {
        window.open(safe, "_blank", "noopener,noreferrer")
      }
      break
    }

    case "copy-url": {
      const url = meta.href ?? meta.src ?? ""
      if (url) {
        navigator.clipboard.writeText(url).catch(() => {
          // Clipboard API may fail in non-secure contexts -- silent fallback
        })
      }
      break
    }

    case "copy-code": {
      const code = meta.code ?? ""
      if (code) {
        navigator.clipboard.writeText(code).catch(() => {
          // Silent fallback
        })
      }
      break
    }

    case "edit-link":
    case "edit-alt":
    case "edit-url":
    case "edit-source": {
      // All "Edit" actions enter Show Raw mode.
      // Future: these could open inline edit popovers. For now,
      // Show Raw is the primary edit mechanism.
      showRaw(view, node)
      break
    }

    case "view-full-size": {
      const src = meta.src ?? ""
      const validated = safeExternalUrl(src)
      if (validated) {
        window.open(validated, "_blank", "noopener,noreferrer")
      }
      break
    }

    case "export-svg": {
      // Find the rendered SVG in the DOM for the mermaid block
      // For now, copy the mermaid source as a fallback
      const code = meta.code ?? ""
      if (code) {
        navigator.clipboard.writeText(code).catch(() => {
          // Silent fallback
        })
      }
      break
    }
  }

  contextMenuBridge.close()
}
