/**
 * Type definitions for doc_view tool interactions.
 *
 * These types match the backend doc_view tool response defined in:
 * backend/internal/service/llm/tools/view.go
 */

// =============================================================================
// INPUT TYPES (from tool_use block)
// =============================================================================

/**
 * Input schema for doc_view tool.
 * Parsed from tool_use block's content.input
 */
export interface DocViewInput {
  /** Unix-style path to document or folder */
  path: string
}

// =============================================================================
// RESULT TYPES (from tool_result block)
// =============================================================================

/**
 * Document result from doc_view tool.
 * Returned when path resolves to a document.
 */
export interface DocViewDocumentResult {
  type: 'document'
  id: string
  name: string
  path: string
  content: string
  word_count: number
  was_truncated?: boolean
}

/**
 * Document metadata in folder listing.
 */
export interface DocViewFolderDocument {
  id: string
  name: string
  word_count: number
  updated_at?: string
}

/**
 * Folder metadata in folder listing.
 */
export interface DocViewFolderChild {
  id: string
  name: string
}

/**
 * Folder result from doc_view tool.
 * Returned when path resolves to a folder.
 */
export interface DocViewFolderResult {
  type: 'folder'
  path: string
  documents: DocViewFolderDocument[]
  folders: DocViewFolderChild[]
}

/**
 * Union type for doc_view results.
 */
export type DocViewResult = DocViewDocumentResult | DocViewFolderResult
