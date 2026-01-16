/**
 * Types for doc_tree tool blocks.
 *
 * These types are used by both:
 * - useTreeStore (core layer) for hydration
 * - DocTreeBlock (features layer) for display
 *
 * Placed in shared types layer to avoid DIP violation
 * (core importing from features).
 */

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
