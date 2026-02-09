/**
 * Live Preview Types
 *
 * SOLID: Open/Closed - NodeRenderer interface allows extension without modification
 */

import type { Decoration } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { ExcludedRegion } from "../state/excludedRegions";

// ============================================================================
// RENDER CONTEXT
// ============================================================================

/**
 * Context passed to renderers for decoration building
 */
export interface RenderContext {
  /** Current editor state */
  state: EditorState;
  /** Pre-computed cursor word bounds for performance */
  cursorWords: Array<{ from: number; to: number }>;
  /** Regions where decorations should be suppressed (e.g., diff hunks).
   *  Empty array when no diff is active. */
  excludedRegions: readonly ExcludedRegion[];
}

// ============================================================================
// DECORATION RANGE
// ============================================================================

/**
 * A decoration with its position range
 */
export interface DecorationRange {
  from: number;
  to: number;
  deco: Decoration;
}

// ============================================================================
// NODE RENDERER INTERFACE (OCP: Open for Extension)
// ============================================================================

/**
 * Interface for node renderers
 *
 * Implement this to add new node type support without modifying the plugin.
 */
export interface NodeRenderer {
  /** Node types this renderer handles (e.g., ['StrongEmphasis', 'Emphasis']) */
  nodeTypes: string[];

  /**
   * Render decorations for a node
   *
   * @param node - The syntax tree node to render
   * @param ctx - Render context with state and cursor info
   * @returns Array of decorations to apply
   */
  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[];
}

// ============================================================================
// INLINE SCANNER INTERFACE (OCP: Open for Extension)
// ============================================================================

/**
 * Interface for regex/pattern-based inline decoration providers.
 *
 * Scanners receive visible text slices and return decorations, coordinated
 * by the live preview plugin (single ViewPlugin rebuild schedule).
 */
export interface InlineScanner {
  /** Unique identifier for debugging and dedup */
  id: string;

  /**
   * Scan visible text and return decorations.
   * Called once per visible range per rebuild cycle.
   *
   * Contract:
   * - Only operate on the provided `text` slice and `offset`
   * - Never call `doc.toString()` — keep work O(viewport)
   * - Check `ctx.excludedRegions` and skip patterns that overlap
   * - Handle cursor proximity internally (pattern-specific reveal)
   */
  scan(text: string, offset: number, ctx: RenderContext): DecorationRange[];
}
