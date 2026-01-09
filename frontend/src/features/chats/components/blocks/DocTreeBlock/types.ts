/**
 * Types for doc_tree tool blocks
 *
 * The doc_tree tool returns a recursive tree structure from the backend,
 * but we use the tree store for rendering (consistent with DocViewBlock).
 */

// =============================================================================
// INPUT TYPES
// =============================================================================

export interface DocTreeInput {
  /** Unix-style folder path (default: "/") */
  folder?: string
  /** Depth to traverse (default: 2, max: 5) */
  depth?: number
}

// =============================================================================
// RESULT TYPES
// =============================================================================

export interface DocTreeResult {
  type: 'tree'
  /** Resolved folder path */
  path: string
  /** Actual depth traversed */
  depth: number
  // Note: Backend also returns folders/documents recursively,
  // but we use tree store for rendering consistency
}
