/**
 * Live Preview Plugin
 *
 * SOLID: Open/Closed - Uses registry pattern for extensibility
 *
 * This plugin hides markdown syntax when cursor is not in the formatted region,
 * showing a clean "live preview" like Obsidian.
 */

import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view'
import { RangeSetBuilder, type EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { NodeRenderer, DecorationRange, RenderContext } from './types'

// ============================================================================
// RENDERER REGISTRY (OCP: Open for Extension)
// ============================================================================

const renderers = new Map<string, NodeRenderer[]>()

/**
 * Register a node renderer
 *
 * Multiple renderers can handle the same node type.
 * Renderers are called in registration order.
 */
export function registerRenderer(renderer: NodeRenderer): void {
  for (const nodeType of renderer.nodeTypes) {
    const existing = renderers.get(nodeType) || []
    renderers.set(nodeType, [...existing, renderer])
  }
}

/**
 * Get all renderers for a node type
 */
export function getRenderers(nodeType: string): NodeRenderer[] {
  return renderers.get(nodeType) || []
}

/**
 * Clear all registered renderers (for testing)
 */
export function clearRenderers(): void {
  renderers.clear()
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get word boundaries around a position (non-whitespace sequence)
 */
export function getWordBounds(
  state: EditorState,
  pos: number
): { from: number; to: number } {
  const line = state.doc.lineAt(pos)
  const lineText = line.text
  const lineStart = line.from
  const offsetInLine = pos - lineStart

  // Handle edge case: position at start of line with whitespace
  if (offsetInLine === 0 && lineText.length > 0) {
    const firstChar = lineText.charAt(0)
    if (/\s/.test(firstChar)) {
      return { from: pos, to: pos }
    }
  }

  // Find start of word (scan backwards for whitespace)
  let wordStart = offsetInLine
  while (wordStart > 0) {
    const char = lineText.charAt(wordStart - 1)
    if (/\s/.test(char)) break
    wordStart--
  }

  // Find end of word (scan forwards for whitespace)
  let wordEnd = offsetInLine
  while (wordEnd < lineText.length) {
    const char = lineText.charAt(wordEnd)
    if (/\s/.test(char)) break
    wordEnd++
  }

  return { from: lineStart + wordStart, to: lineStart + wordEnd }
}

/**
 * Check if cursor is in the same "word" as a formatting node
 */
export function cursorInSameWord(
  cursorWords: Array<{ from: number; to: number }>,
  nodeFrom: number,
  nodeTo: number
): boolean {
  for (const cursorWord of cursorWords) {
    if (cursorWord.from < nodeTo && cursorWord.to > nodeFrom) {
      return true
    }
  }
  return false
}

/**
 * Check if selection overlaps a range
 */
export function selectionOverlapsRange(
  state: EditorState,
  from: number,
  to: number
): boolean {
  const { selection } = state
  for (const range of selection.ranges) {
    if (range.from < to && range.to > from) {
      return true
    }
  }
  return false
}

/**
 * Get line range for a position
 */
export function getLineRange(
  state: EditorState,
  pos: number
): { from: number; to: number } {
  const line = state.doc.lineAt(pos)
  return { from: line.from, to: line.to }
}

// ============================================================================
// LIVE PREVIEW PLUGIN
// ============================================================================

class LivePreviewPlugin {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view)
  }

  update(update: ViewUpdate) {
    // Rebuild when document, selection, or viewport changes
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view)
    }
  }

  /**
   * Cleanup method called when plugin is destroyed.
   * Currently no external resources to clean up, but adding for:
   * 1. Future-proofing (may add event listeners, subscriptions later)
   * 2. CodeMirror best practice compliance
   */
  destroy() {
    // No external resources to clean up currently
  }

  buildDecorations(view: EditorView): DecorationSet {
    const { state } = view
    const decorations: DecorationRange[] = []

    // Pre-compute cursor word bounds for performance
    const cursorWords = state.selection.ranges.map(range =>
      getWordBounds(state, range.head)
    )

    const ctx: RenderContext = { state, cursorWords }

    // Iterate through syntax tree for visible ranges only
    const tree = syntaxTree(state)

    for (const { from, to } of view.visibleRanges) {
      tree.iterate({
        from,
        to,
        enter(node) {
          // Get renderers for this node type
          const nodeRenderers = getRenderers(node.name)

          // Call each renderer and collect decorations
          // Wrap in try-catch for resilience - a buggy renderer shouldn't crash the editor
          for (const renderer of nodeRenderers) {
            try {
              const decos = renderer.render(node.node, ctx)
              decorations.push(...decos)
            } catch (error) {
              console.warn(`[LivePreview] Renderer for ${node.name} failed:`, error)
              // Continue with other renderers - don't crash entire editor
            }
          }
        },
      })
    }

    // Sort decorations by position (required by RangeSetBuilder)
    // Point decorations (where to === from) come before range decorations
    decorations.sort((a, b) => {
      if (a.from !== b.from) return a.from - b.from
      const aIsPoint = a.to === a.from
      const bIsPoint = b.to === b.from
      if (aIsPoint && !bIsPoint) return -1
      if (!aIsPoint && bIsPoint) return 1
      return a.to - b.to
    })

    // Build the decoration set
    const builder = new RangeSetBuilder<Decoration>()
    for (const { from, to, deco } of decorations) {
      builder.add(from, to, deco)
    }

    return builder.finish()
  }
}

export const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: v => v.decorations,
})
