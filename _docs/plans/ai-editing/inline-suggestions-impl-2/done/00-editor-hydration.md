# Phase 0: Editor Hydration Controls (Required)

## Goal

Make editor hydration/refresh safe:
- server → editor updates don’t pollute undo history
- server → editor updates don’t trigger autosave via React `onChange`
- diff-mode hydration bypasses diff edit filters when replacing marker ranges
- diff-mode disables live preview via a Compartment

## Steps

### 0.1: Update `CodeMirrorEditorRef.setContent` options

Update `frontend/src/core/editor/codemirror/types.ts`:

```typescript
interface SetContentOptions {
  /** If false, don't add to undo history. Default: true */
  addToHistory?: boolean

  /**
   * If false, do not call the React `onChange` callback for this setContent().
   * Use this for hydration/refresh (server → editor), not for user actions.
   *
   * Default: true
   */
  emitChange?: boolean
}

export interface EditorRef {
  getContent(): string
  setContent(content: string, options?: SetContentOptions): void
  focus(): void
  getView(): EditorView | null
}
```

Update `frontend/src/core/editor/codemirror/CodeMirrorEditor.tsx`:

```typescript
import { Transaction, Annotation } from '@codemirror/state'

// Module-scope annotation shared by setContent() + updateListener.
// When present, the React onChange callback is suppressed for that transaction.
const suppressOnChange = Annotation.define<boolean>()

setContent(content: string, options?: SetContentOptions) {
  if (!viewRef.current) return

  const addToHistory = options?.addToHistory !== false
  const emitChange = options?.emitChange !== false

  const annotations = [
    ...(addToHistory ? [] : [Transaction.addToHistory.of(false)]),
    ...(emitChange ? [] : [suppressOnChange.of(true)]),
  ]

  viewRef.current.dispatch({
    changes: { from: 0, to: viewRef.current.state.doc.length, insert: content },
    annotations: annotations.length > 0 ? annotations : undefined,
    // Hydration/refresh replaces marker ranges; bypass diffEditFilter.
    filter: addToHistory === false ? false : undefined,
  })
}
```

Also update the `onReady({ ... })` object’s `setContent` implementation to accept the same `options?: SetContentOptions` and apply the same annotations (there are two `setContent` implementations in this component today).

Update the update listener in `CodeMirrorEditor.tsx` to honor the annotation:

```typescript
const updateListener = EditorView.updateListener.of(update => {
  const shouldSuppress = update.transactions.some(tr => tr.annotation(suppressOnChange) === true)
  if (!shouldSuppress && update.docChanged && onChange) {
    onChange(update.state.doc.toString())
  }
})
```

### 0.2: Disable live preview while diff mode is active

In diff mode, the editor displays a merged doc (deleted + inserted). Rendering live preview from that is confusing, so wrap live preview in a Compartment.

**Note:** The live preview plugin is exported from `frontend/src/core/editor/codemirror/livePreview/index.ts` as `livePreviewPlugin`.

In `frontend/src/core/editor/codemirror/CodeMirrorEditor.tsx`:

```typescript
import { livePreviewPlugin } from './livePreview'

const livePreviewCompartment = new Compartment()

// In extensions:
livePreviewCompartment.of(livePreviewPlugin),

// Expose on the ref:
setLivePreviewEnabled: (enabled: boolean) => {
  viewRef.current?.dispatch({
    effects: livePreviewCompartment.reconfigure(
      enabled ? livePreviewPlugin : []
    ),
  })
},
```

## Verification Checklist

- [ ] Hydration uses `setContent(..., { addToHistory:false, emitChange:false })` without triggering autosave
- [ ] Hydration bypasses diff edit filters when replacing marker ranges
- [ ] Live preview toggles off in diff mode and back on when diff mode ends

