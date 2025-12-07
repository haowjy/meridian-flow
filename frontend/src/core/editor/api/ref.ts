import { EditorView } from '@codemirror/view'
import type {
  AIEditorRef,
  DecorationAttrs,
  DecorationHandle,
  DecorationInfo,
} from './types'
import {
  addDecorationEffect,
  removeDecorationEffect,
  clearDecorationsEffect,
  aiDecorationField,
} from './decorations'

let decorationIdCounter = 0

/**
 * Create an AIEditorRef from an EditorView.
 *
 * This is the DIP boundary - features use AIEditorRef,
 * only core editor knows about EditorView.
 */
export function createAIEditorRef(view: EditorView | null): AIEditorRef {
  return {
    // Content access
    getContent(): string {
      return view?.state.doc.toString() ?? ''
    },

    getSelectedText(): string {
      if (!view) return ''
      const { from, to } = view.state.selection.main
      return view.state.sliceDoc(from, to)
    },

    getSelection(): { from: number; to: number } {
      if (!view) return { from: 0, to: 0 }
      const { from, to } = view.state.selection.main
      return { from, to }
    },

    // Content modification
    replaceRange(from: number, to: number, text: string): void {
      view?.dispatch({
        changes: { from, to, insert: text },
      })
    },

    insertAt(position: number, text: string): void {
      view?.dispatch({
        changes: { from: position, to: position, insert: text },
      })
    },

    replaceAll(text: string): void {
      if (!view) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      })
    },

    // Decoration management
    addDecoration(from: number, to: number, attrs: DecorationAttrs): DecorationHandle {
      const id = `dec_${++decorationIdCounter}_${Date.now()}`

      view?.dispatch({
        effects: addDecorationEffect.of({ id, from, to, attrs }),
      })

      return { id, from, to }
    },

    removeDecoration(handle: DecorationHandle): void {
      view?.dispatch({
        effects: removeDecorationEffect.of(handle.id),
      })
    },

    removeDecorations(filter: (attrs: DecorationAttrs) => boolean): void {
      view?.dispatch({
        effects: clearDecorationsEffect.of(filter),
      })
    },

    getDecorations(filter?: (attrs: DecorationAttrs) => boolean): DecorationInfo[] {
      if (!view) return []

      const field = view.state.field(aiDecorationField, false)
      if (!field) return []

      const results: DecorationInfo[] = []

      for (const [id, stored] of field.metadata) {
        if (!filter || filter(stored.attrs)) {
          results.push({
            handle: { id, from: stored.from, to: stored.to },
            from: stored.from,
            to: stored.to,
            attrs: stored.attrs,
          })
        }
      }

      return results
    },

    clearAllDecorations(): void {
      view?.dispatch({
        effects: clearDecorationsEffect.of(null),
      })
    },

    // Navigation
    scrollToPosition(pos: number): void {
      view?.dispatch({
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      })
    },

    scrollToLine(line: number): void {
      if (!view) return
      const lineInfo = view.state.doc.line(line)
      view.dispatch({
        effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
      })
    },

    focus(): void {
      view?.focus()
    },

    // Internal access
    getView(): EditorView | null {
      return view
    },
  }
}
