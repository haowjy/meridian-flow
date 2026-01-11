/**
 * Types for doc_tree tool blocks
 *
 * The doc_tree tool returns a recursive tree structure from the backend.
 * We hydrate the tree store from this data so FolderTreeView can render it.
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
// RESULT TYPES (Nested structure from backend)
// =============================================================================

/** Document info in tool result (subset of full Document type) */
export interface DocTreeDocument {
  id: string
  /** Full name with extension (e.g., "README.md") */
  name: string
  /** File extension with dot (e.g., ".md") */
  extension: string
  word_count: number
  updated_at: string
}

/** Folder info in tool result (recursive structure) */
export interface DocTreeFolder {
  id: string
  name: string
  folders: DocTreeFolder[]
  documents: DocTreeDocument[]
}

export interface DocTreeResult {
  type: 'tree'
  /** Resolved folder path */
  path: string
  /** Actual depth traversed */
  depth: number
  /** Nested folders at this level */
  folders: DocTreeFolder[]
  /** Documents at this level */
  documents: DocTreeDocument[]
}
