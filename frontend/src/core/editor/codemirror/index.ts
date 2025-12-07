// Public API for CodeMirror editor
export { CodeMirrorEditor } from './CodeMirrorEditor'
export type {
  CodeMirrorEditorRef,
  CodeMirrorEditorOptions,
  WordCount,
} from './types'

// Extension bundles (SOLID: SRP)
export {
  markdownEditor,
  minimalEditor,
  readonlyViewer,
  type MarkdownEditorOptions,
  type MinimalEditorOptions,
  type ReadonlyViewerOptions,
} from './extensions'

// Compartments for runtime reconfiguration (SOLID: ISP)
export {
  setEditable,
  setLanguage,
  setTheme,
  setLivePreview,
} from './compartments'

// Facets for configuration (SOLID: OCP)
export {
  editorConfigFacet,
  getEditorConfig,
  renderingConfigFacet,
  getRenderingConfig,
  type EditorConfig,
  type RenderingConfig,
} from './facets'

// Re-export setup utilities for advanced use cases
export { createBaseExtensions, createEditorState } from './setup'

// Commands (for direct use or custom integrations)
export {
  toggleBold,
  toggleItalic,
  toggleHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleInlineCode,
  insertLink,
  isFormatActive,
} from './commands'

// Word count
export { wordCountField, getWordCount } from './extensions/wordCount'

// Editor caching
export { editorCache, useEditorCache } from '../cache'

// AI integration API (DIP boundary)
export type {
  AIEditorRef,
  DecorationAttrs,
  DecorationHandle,
  DecorationInfo,
} from '../api'
export { createAIEditorRef, aiDecorations } from '../api'
