/**
 * Types for doc_tree tool blocks
 *
 * The doc_tree tool returns a recursive tree structure from the backend.
 * We hydrate the tree store from this data so FolderTreeView can render it.
 */

// Re-export shared types for backwards compatibility
export type { DocTreeDocument, DocTreeFolder } from "@/types/docTree";

// =============================================================================
// INPUT TYPES
// =============================================================================

export interface DocTreeInput {
  /** Unix-style folder path (default: "/") */
  path?: string;
  /** Legacy parameter name for backward compatibility */
  folder?: string;
  /** Depth to traverse (default: 2, max: 5) */
  depth?: number;
}

// =============================================================================
// RESULT TYPES (Nested structure from backend)
// =============================================================================

// Import for use in DocTreeResult
import type { DocTreeFolder, DocTreeDocument } from "@/types/docTree";

export interface DocTreeResult {
  type: "tree";
  /** Resolved folder path */
  path: string;
  /** Actual depth traversed */
  depth: number;
  /** Nested folders at this level */
  folders: DocTreeFolder[];
  /** Documents at this level */
  documents: DocTreeDocument[];
}
