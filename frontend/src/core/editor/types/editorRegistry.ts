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
export type EditorType = 'markdown' | 'excalidraw' | 'mermaid'

// ============================================================================
// BASE INTERFACES
// ============================================================================

/**
 * Base interface that all editors must implement.
 * Minimal contract for content access and focus management.
 *
 * Content type is flexible:
 * - markdown: string
 * - excalidraw: object (Excalidraw scene JSON)
 * - mermaid: string (Mermaid syntax)
 */
export interface BaseEditorRef {
  /** Get current content (format depends on editor type) */
  getContent(): string | object
  /** Set content (format depends on editor type) */
  setContent(content: string | object): void
  /** Focus the editor */
  focus(): void
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
  type: EditorType
  /** Human-readable label */
  label: string
  /** File extensions this editor handles (e.g., ['.md', '.markdown']) */
  extensions: string[]
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
 * detectEditorType('diagram.excalidraw') // 'excalidraw'
 * detectEditorType('flowchart.mmd') // 'mermaid'
 */
export function detectEditorType(filename: string): EditorType {
  const ext = filename.split('.').pop()?.toLowerCase()

  switch (ext) {
    case 'excalidraw':
      return 'excalidraw'
    case 'mmd':
    case 'mermaid':
      return 'mermaid'
    default:
      // Default to markdown for .md, .markdown, .txt, or any unknown extension
      return 'markdown'
  }
}

// ============================================================================
// FUTURE: EDITOR REGISTRY
// ============================================================================

// When implementing multi-editor support, add:
//
// const editorRegistry = new Map<EditorType, EditorDefinition>()
//
// export function registerEditor(definition: EditorDefinition): void {
//   editorRegistry.set(definition.type, definition)
// }
//
// export function getEditor(type: EditorType): EditorDefinition | undefined {
//   return editorRegistry.get(type)
// }
