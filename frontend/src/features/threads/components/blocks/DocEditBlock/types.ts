/**
 * Type definitions for doc_edit tool interactions.
 *
 * These types match the backend doc_edit tool schema defined in:
 * backend/internal/domain/models/llm/tool_definition.go
 */

// =============================================================================
// INPUT TYPES (from tool_use block)
// =============================================================================

/** Available doc_edit commands */
export type DocEditCommand = 'str_replace' | 'insert' | 'append' | 'create'

/**
 * Input schema for doc_edit tool.
 * Parsed from tool_use block's content.input
 */
export interface DocEditInput {
  /** The edit command type */
  command: DocEditCommand
  /** Unix-style document path (e.g., "/Chapter 5.md", "/Characters/Hero.md") */
  path: string
  /** Text to find and replace (str_replace only) */
  old_str?: string
  /** New text to insert/replace with (str_replace, insert, append) */
  new_str?: string
  /** Line number for insertion (insert only, 0 = start of file) */
  insert_line?: number
  /** Full file content (create only) */
  file_text?: string
}

// =============================================================================
// RESULT TYPES (from tool_result block)
// =============================================================================

/**
 * Success result from doc_edit tool.
 */
export interface DocEditSuccessResult {
  path: string
  message: string
}

/**
 * Error codes returned by doc_edit tool.
 */
export type DocEditErrorCode =
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'DOC_NOT_FOUND'
  | 'INVALID_LINE'
  | 'ALREADY_EXISTS'

/**
 * Error result from doc_edit tool.
 */
export interface DocEditErrorResult {
  success: false
  error_code: DocEditErrorCode
  message: string
  error_data?: Record<string, unknown>
}

// =============================================================================
// DISPLAY LABELS
// =============================================================================

/** Human-readable labels for each command type */
export const COMMAND_LABELS: Record<DocEditCommand, string> = {
  str_replace: 'Replace',
  insert: 'Insert',
  append: 'Append',
  create: 'Create',
}
