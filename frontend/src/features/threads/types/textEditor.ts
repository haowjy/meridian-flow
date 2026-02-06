/**
 * Type definitions for str_replace_based_edit_tool interactions.
 *
 * This unified tool combines view and edit operations, matching
 * Anthropic's text_editor_20250728 API.
 *
 * Backend schema: backend/internal/domain/models/llm/tool_definition.go
 */

// =============================================================================
// INPUT TYPES (from tool_use block)
// =============================================================================

/** Available text editor commands */
export type TextEditorCommand = "view" | "str_replace" | "create" | "insert";

/**
 * Input schema for str_replace_based_edit_tool.
 * Parsed from tool_use block's content.input
 */
export interface TextEditorInput {
  /** The command to execute */
  command: TextEditorCommand;
  /** Unix-style path to document or folder */
  path: string;
  /** For view: optional [start_line, end_line] range */
  view_range?: [number, number];
  /** For str_replace: exact text to find and replace */
  old_str?: string;
  /** For str_replace/insert: replacement or insertion text */
  new_str?: string;
  /** For insert: line number to insert after (0 = start) */
  insert_line?: number;
  /** For create: initial content for the new document */
  file_text?: string;
}

// =============================================================================
// RESULT TYPES (from tool_result block)
// =============================================================================

/**
 * Document result from view command.
 * Returned when path resolves to a document.
 */
export interface TextEditorDocumentResult {
  type: "document";
  id: string;
  name: string;
  path: string;
  /** Line-numbered content (e.g., "1: line1\n2: line2") */
  content: string;
  total_lines: number;
  view_range: [number, number];
  word_count: number;
  was_truncated?: boolean;
}

/**
 * Document metadata in folder listing.
 */
export interface TextEditorFolderDocument {
  id: string;
  name: string;
  word_count: number;
  updated_at?: string;
}

/**
 * Folder metadata in folder listing.
 */
export interface TextEditorFolderChild {
  id: string;
  name: string;
}

/**
 * Folder result from view command.
 * Returned when path resolves to a folder.
 */
export interface TextEditorFolderResult {
  type: "folder";
  path: string;
  documents: TextEditorFolderDocument[];
  folders: TextEditorFolderChild[];
}

/**
 * Success result from edit commands (str_replace, insert, create).
 */
export interface TextEditorEditResult {
  path: string;
  message: string;
  documentId?: string; // Only for create command
}

/**
 * Error codes returned by text editor tool.
 */
export type TextEditorErrorCode =
  | "NO_MATCH"
  | "AMBIGUOUS_MATCH"
  | "DOC_NOT_FOUND"
  | "INVALID_LINE"
  | "ALREADY_EXISTS"
  | "MISSING_PARAM"
  | "INVALID_INPUT"
  | "NOT_FOUND";

/**
 * Error result from text editor tool.
 */
export interface TextEditorErrorResult {
  success: false;
  error_code: TextEditorErrorCode;
  message: string;
  error_data?: Record<string, unknown>;
}

/**
 * Union type for view results.
 */
export type TextEditorViewResult =
  | TextEditorDocumentResult
  | TextEditorFolderResult;

// =============================================================================
// DISPLAY LABELS
// =============================================================================

/** Human-readable labels for each command type */
export const COMMAND_LABELS: Record<TextEditorCommand, string> = {
  view: "View",
  str_replace: "Replace",
  create: "Create",
  insert: "Insert",
};

// =============================================================================
// TYPE GUARDS
// =============================================================================

export function isViewCommand(command: TextEditorCommand): boolean {
  return command === "view";
}

export function isEditCommand(command: TextEditorCommand): boolean {
  return (
    command === "str_replace" || command === "create" || command === "insert"
  );
}

export function isDocumentResult(
  result: unknown,
): result is TextEditorDocumentResult {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as Record<string, unknown>).type === "document"
  );
}

export function isFolderResult(
  result: unknown,
): result is TextEditorFolderResult {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as Record<string, unknown>).type === "folder"
  );
}
