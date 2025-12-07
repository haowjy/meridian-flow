import { EditorState, Extension } from '@codemirror/state'
import { markdownEditor } from './extensions/bundle'

/**
 * Create the base extensions for a markdown editor.
 * This is a convenience wrapper around the markdownEditor bundle.
 *
 * @deprecated Use markdownEditor() directly for better SOLID compliance.
 */
export function createBaseExtensions(options: {
  placeholder?: string
  editable?: boolean
}): Extension[] {
  return markdownEditor({
    placeholder: options.placeholder,
    editable: options.editable,
  })
}

/**
 * Create an EditorState with the given content and extensions.
 */
export function createEditorState(
  content: string,
  extensions: Extension[]
): EditorState {
  return EditorState.create({
    doc: content,
    extensions,
  })
}
