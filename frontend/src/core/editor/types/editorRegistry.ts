/**
 * Editor Registry Types
 *
 * Foundational types for multi-editor support.
 * Enables different editors (CodeMirror, Excalidraw, Mermaid) to be registered
 * and switched based on document file type.
 *
 * SOLID: Open/Closed - New editor types can be added without modifying existing code
 */

// ============================================================================
// EDITOR TYPES
// ============================================================================

/**
 * Supported editor types.
 * Extensible - add new types as needed.
 */
export type EditorType =
  | "markdown"
  | "latex"
  | "plaintext"
  | "excalidraw"
  | "mermaid";

// ============================================================================
// BASE INTERFACES
// ============================================================================

/**
 * Base interface that all editors must implement.
 * Minimal contract for content access and focus management.
 *
 * @template TContent - Editor content type (string for markdown/latex, object for excalidraw, etc.)
 *
 * Content type examples:
 * - markdown: string
 * - latex: string
 * - plaintext: string
 * - excalidraw: object (Excalidraw scene JSON)
 * - mermaid: string (Mermaid syntax)
 */
export interface BaseEditorRef<TContent = string | object> {
  /** Get current content (format depends on editor type) */
  getContent(): TContent;
  /** Set content (format depends on editor type) */
  setContent(
    content: TContent,
    options?: { addToHistory?: boolean; emitChange?: boolean },
  ): void;
  /** Set editable state (read-only vs editable) */
  setEditable(editable: boolean): void;
  /** Focus the editor */
  focus(): void;
}

// ============================================================================
// EDITOR DEFINITION
// ============================================================================

/**
 * Definition for registering an editor type.
 * Used by the (future) editor factory to instantiate the correct editor.
 */
export interface EditorDefinition {
  /** Editor type identifier */
  type: EditorType;
  /** Human-readable label */
  label: string;
  /** File extensions this editor handles (e.g., ['.md', '.markdown']) */
  extensions: string[];
  // Component and toolbar will be added when implementing specific editors
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Detect editor type from filename extension.
 *
 * @param filename - File name or path
 * @returns EditorType - defaults to 'markdown' if unknown
 *
 * @example
 * detectEditorType('chapter1.md') // 'markdown'
 * detectEditorType('paper.tex') // 'latex'
 * detectEditorType('notes.txt') // 'plaintext'
 * detectEditorType('diagram.excalidraw') // 'excalidraw'
 * detectEditorType('flowchart.mmd') // 'mermaid'
 */
export function detectEditorType(filename: string): EditorType {
  const ext = filename.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "excalidraw":
      return "excalidraw";
    case "mmd":
    case "mermaid":
      return "mermaid";
    case "tex":
    case "latex":
      return "latex";
    case "txt":
      return "plaintext";
    case "md":
    case "markdown":
      return "markdown";
    default:
      // Default to markdown for unknown extensions
      return "markdown";
  }
}

