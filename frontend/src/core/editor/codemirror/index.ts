/**
 * CodeMirror Editor - Public API
 *
 * This module provides a markdown editor with:
 * - Obsidian-style live preview
 * - Smart list continuation
 * - Auto-closing brackets
 * - Formatting commands
 */

// Main component
export { CodeMirrorEditor } from './CodeMirrorEditor'

// Components
export { EditorContextMenu } from './components'

// Types
export type {
  CodeMirrorEditorRef,
  CodeMirrorEditorOptions,
  WordCount,
  FormatType,
  EditorRef,
  FormattingRef,
  ListRef,
  FormatDetectionRef,
  WordCountRef,
} from './types'

// Commands (for external use)
export {
  toggleBold,
  toggleItalic,
  toggleInlineCode,
  toggleHeading,
  insertLink,
  toggleBulletList,
  toggleOrderedList,
  isFormatActive,
} from './commands'

// Extensions (for custom configurations)
export { markdownLanguage, editorTheme, getWordCount } from './extensions'

// Live preview (for extending with custom renderers)
export { registerRenderer, livePreviewPlugin } from './livePreview'
export type { NodeRenderer, RenderContext, DecorationRange } from './livePreview'
