import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

/**
 * Pull-based API for accessing editor content.
 *
 * Do NOT call doc.toString() on every keystroke. This API provides
 * on-demand access -- callers invoke getContent() only when they
 * actually need the full text (save, export).
 *
 * Word count is debounced internally (500ms after last edit) and cached
 * between calls. Character count reads doc.length directly (cheap).
 */
export interface EditorContentAPI {
  /** Returns the full document text. Call only when needed (save, export). */
  getContent(): string
  /** Returns word count. Debounced internally, cached between calls. */
  getWordCount(): number
  /** Returns character count. Cheap -- reads doc.length. */
  getCharCount(): number
}

/**
 * Creates a word count listener extension and returns both the extension
 * and a getter for the cached word count.
 *
 * The listener fires 500ms after the last edit, computing word count
 * asynchronously to avoid jank during rapid typing.
 */
export function createWordCountExtension(): {
  extension: Extension
  getWordCount: () => number
} {
  let cachedWordCount = 0
  let initialized = false
  let wordCountTimeout: ReturnType<typeof setTimeout> | null = null

  const extension = EditorView.updateListener.of((update) => {
    // Initialize word count from the initial document on first update
    if (!initialized) {
      initialized = true
      const text = update.state.doc.toString()
      cachedWordCount = text.split(/\s+/).filter(Boolean).length
    }
    if (!update.docChanged) return

    if (wordCountTimeout) clearTimeout(wordCountTimeout)
    wordCountTimeout = setTimeout(() => {
      const text = update.state.doc.toString()
      cachedWordCount = text.split(/\s+/).filter(Boolean).length
    }, 500)
  })

  return {
    extension,
    getWordCount: () => cachedWordCount,
  }
}
