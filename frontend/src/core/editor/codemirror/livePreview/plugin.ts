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
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type {
  NodeRenderer,
  InlineScanner,
  DecorationRange,
  RenderContext,
} from "./types";
import { getWordBounds } from "./cursorUtils";
import { hunkRegionsField } from "../diffView/hunkRegionsField";
import { overlapsExcludedRegion } from "../state/excludedRegions";

// ============================================================================
// RENDERER REGISTRY (OCP: Open for Extension)
// ============================================================================

const renderers = new Map<string, NodeRenderer[]>();

/**
 * Register a node renderer
 *
 * Multiple renderers can handle the same node type.
 * Renderers are called in registration order.
 */
export function registerRenderer(renderer: NodeRenderer): void {
  for (const nodeType of renderer.nodeTypes) {
    const existing = renderers.get(nodeType) || [];
    renderers.set(nodeType, [...existing, renderer]);
  }
}

/**
 * Get all renderers for a node type
 */
export function getRenderers(nodeType: string): NodeRenderer[] {
  return renderers.get(nodeType) || [];
}

/**
 * Clear all registered renderers (for testing)
 */
export function clearRenderers(): void {
  renderers.clear();
}

// ============================================================================
// SCANNER REGISTRY (OCP: Open for Extension)
// ============================================================================

const scanners = new Map<string, InlineScanner>();

/**
 * Register an inline scanner.
 *
 * Scanners are called in registration order for each visible range.
 */
export function registerScanner(scanner: InlineScanner): void {
  scanners.set(scanner.id, scanner);
}

/**
 * Clear all registered scanners (for testing)
 */
export function clearScanners(): void {
  scanners.clear();
}

// ============================================================================
// LIVE PREVIEW PLUGIN
// ============================================================================

class LivePreviewPlugin {
  decorations: DecorationSet;
  private view: EditorView;
  private pendingRebuild = false;
  private onPointerUp: () => void;

  constructor(view: EditorView) {
    this.view = view;
    this.decorations = this.buildDecorations(view);

    // Listen on document so we catch releases outside the editor
    this.onPointerUp = () => {
      if (this.pendingRebuild) {
        this.pendingRebuild = false;
        // setTimeout so the pointerup finishes before we dispatch,
        // which triggers a new update cycle with no pointer event.
        // Set selection explicitly so selectionSet=true and
        // the update handler rebuilds decorations.
        setTimeout(() => {
          this.view.dispatch({ selection: this.view.state.selection });
        }, 0);
      }
    };
    document.addEventListener("pointerup", this.onPointerUp);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      // Content or viewport changed — always rebuild immediately
      this.decorations = this.buildDecorations(update.view);
      return;
    }

    if (update.selectionSet) {
      // Pointer-driven selection (drag-select): defer rebuild to avoid
      // flicker when decorations toggle mid-drag (known CM6 issue).
      const isPointer = update.transactions.some((tr) =>
        tr.isUserEvent("select.pointer"),
      );
      if (isPointer) {
        this.pendingRebuild = true;
        return;
      }

      // Keyboard navigation — rebuild immediately
      this.decorations = this.buildDecorations(update.view);
    }
  }

  destroy() {
    document.removeEventListener("pointerup", this.onPointerUp);
  }

  buildDecorations(view: EditorView): DecorationSet {
    const { state } = view;
    const decorations: DecorationRange[] = [];

    // Get hunk regions as excluded regions (empty array if diff view not active).
    // The `false` param means don't throw if field doesn't exist.
    const excludedRegions = state.field(hunkRegionsField, false) ?? [];

    // Pre-compute cursor word bounds for performance.
    // For non-collapsed selections (drag-select), also include the full selection
    // extent so cursorInSameWord reveals syntax for any node within the selection.
    const cursorWords = state.selection.ranges.flatMap((range) => {
      const headWord = getWordBounds(state, range.head);
      if (!range.empty) {
        return [headWord, { from: range.from, to: range.to }];
      }
      return [headWord];
    });

    const ctx: RenderContext = { state, cursorWords, excludedRegions };

    // Iterate through syntax tree for visible ranges only
    const tree = syntaxTree(state);

    for (const { from, to } of view.visibleRanges) {
      // --- Syntax-tree renderers ---
      tree.iterate({
        from,
        to,
        enter(node) {
          // Skip nodes inside excluded regions - show raw markdown there
          // This allows diff view styling to take precedence
          if (
            excludedRegions.length > 0 &&
            overlapsExcludedRegion(excludedRegions, node.from, node.to)
          ) {
            return;
          }

          // Get renderers for this node type
          const nodeRenderers = getRenderers(node.name);

          // Call each renderer and collect decorations
          // Wrap in try-catch for resilience - a buggy renderer shouldn't crash the editor
          for (const renderer of nodeRenderers) {
            try {
              const decos = renderer.render(node.node, ctx);
              decorations.push(...decos);
            } catch (error) {
              console.warn(
                `[LivePreview] Renderer for ${node.name} failed:`,
                error,
              );
              // Continue with other renderers - don't crash entire editor
            }
          }
        },
      });

      // --- Inline scanners (regex/pattern-based) ---
      if (scanners.size > 0) {
        const text = state.doc.sliceString(from, to);
        for (const scanner of scanners.values()) {
          try {
            const decos = scanner.scan(text, from, ctx);
            decorations.push(...decos);
          } catch (error) {
            console.warn(
              `[LivePreview] Scanner "${scanner.id}" failed:`,
              error,
            );
          }
        }
      }
    }

    // Sort decorations by position (required by RangeSetBuilder)
    // Point decorations (where to === from) come before range decorations
    decorations.sort((a, b) => {
      if (a.from !== b.from) return a.from - b.from;
      const aIsPoint = a.to === a.from;
      const bIsPoint = b.to === b.from;
      if (aIsPoint && !bIsPoint) return -1;
      if (!aIsPoint && bIsPoint) return 1;
      return a.to - b.to;
    });

    // Build the decoration set
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to, deco } of decorations) {
      builder.add(from, to, deco);
    }

    return builder.finish();
  }
}

export const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (v) => v.decorations,
});
