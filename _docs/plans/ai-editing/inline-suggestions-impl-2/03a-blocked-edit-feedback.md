# Phase 3a: Blocked Edit Feedback

## Goal

Provide user feedback when edits are blocked in DEL regions. Users should understand why their typing isn't working.

## What You're Building

A notification system that:
1. Detects when the edit filter blocks a transaction
2. Shows a non-intrusive toast: "Can't edit deleted text. Accept or reject the change first."
3. Auto-dismisses after 3 seconds
4. Doesn't spam (debounce repeated blocks)

## Architecture: StateEffect-based (Recommended)

- Edit filter dispatches a `blockedEditEffect` when blocking
- React component listens via `EditorView.updateListener`
- Shows toast via your existing toast system

This keeps the CM6 extension pure (no React coupling) while still providing UI feedback.

## Steps

### Step 3a.1: Create the blocked edit effect

Create `frontend/src/core/editor/codemirror/diffView/blockedEditEffect.ts`:

```typescript
import { StateEffect } from '@codemirror/state'

/**
 * Effect dispatched when an edit is blocked in a DEL region.
 * Listeners can show user feedback.
 */
export const blockedEditEffect = StateEffect.define<{
  reason: 'del_region' | 'marker_touched'
}>()
```

---

### Step 3a.2: Update edit filter to dispatch effect

Update `frontend/src/core/editor/codemirror/diffView/editFilter.ts`:

```typescript
import { blockedEditEffect } from './blockedEditEffect'

export const diffEditFilter = EditorState.transactionFilter.of((tr) => {
  // Pass through non-editing transactions
  if (!tr.docChanged) {
    return tr
  }

  const doc = tr.startState.doc.toString()
  if (!containsAnyMarker(doc)) return tr

  const hunks = extractHunks(doc)
  let shouldBlock = false
  let blockReason: 'del_region' | 'marker_touched' = 'del_region'

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, _inserted) => {
    const replacedText = doc.slice(fromA, toA)
    const insertedText = _inserted.toString()

    // 1) Block marker edits
    if (containsAnyMarker(replacedText) || containsAnyMarker(insertedText)) {
      shouldBlock = true
      blockReason = 'marker_touched'
      return
    }

    // 2) Block DEL region edits
    for (const hunk of hunks) {
      if (fromA <= hunk.delEnd && toA >= hunk.delStart) {
        shouldBlock = true
        blockReason = 'del_region'
        return
      }

      // 3) Block inserting between DEL_END and INS_START
      if (fromA === toA && fromA === hunk.insStart) {
        shouldBlock = true
        blockReason = 'marker_touched'
        return
      }
    }
  })

  if (shouldBlock) {
    // Return a transaction that only has the effect (no changes)
    // This allows listeners to show feedback without the edit happening
    return {
      effects: blockedEditEffect.of({ reason: blockReason })
    }
  }

  return tr
})
```

---

### Step 3a.3: Create a listener extension for the effect

Create `frontend/src/core/editor/codemirror/diffView/blockedEditListener.ts`:

```typescript
import { EditorView } from '@codemirror/view'
import { blockedEditEffect } from './blockedEditEffect'

export type BlockedEditCallback = (reason: 'del_region' | 'marker_touched') => void

/**
 * Create an extension that listens for blocked edit effects.
 *
 * @param callback - Called when an edit is blocked
 */
export function createBlockedEditListener(callback: BlockedEditCallback) {
  return EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(blockedEditEffect)) {
          callback(effect.value.reason)
        }
      }
    }
  })
}
```

---

### Step 3a.4: Update the extension bundle

Update `frontend/src/core/editor/codemirror/diffView/plugin.ts`:

```typescript
import { createBlockedEditListener, type BlockedEditCallback } from './blockedEditListener'

export interface DiffViewExtensionOptions {
  /** Called when an edit is blocked (for showing toast) */
  onBlockedEdit?: BlockedEditCallback
}

export function createDiffViewExtension(options?: DiffViewExtensionOptions): Extension {
  const extensions: Extension[] = [
    diffViewPlugin,
    diffEditFilter,
  ]

  if (options?.onBlockedEdit) {
    extensions.push(createBlockedEditListener(options.onBlockedEdit))
  }

  return extensions
}
```

---

### Step 3a.5: Wire up in EditorPanel with debounce

Update `frontend/src/features/documents/components/EditorPanel.tsx`:

```typescript
import { useToast } from '@/shared/components/ui/use-toast'

// Inside EditorPanel component:

const { toast } = useToast()

// Debounce ref to prevent toast spam
const lastBlockedToastRef = useRef<number>(0)
const TOAST_DEBOUNCE_MS = 2000

const handleBlockedEdit = useCallback((reason: 'del_region' | 'marker_touched') => {
  const now = Date.now()
  if (now - lastBlockedToastRef.current < TOAST_DEBOUNCE_MS) return
  lastBlockedToastRef.current = now

  const message = reason === 'del_region'
    ? "Can't edit deleted text. Accept or reject the change first."
    : "Can't modify diff markers."

  toast({
    description: message,
    duration: 3000,
  })
}, [toast])

// In handleEditorReady or the diff extension setup:
const diffExtension = useMemo(() =>
  createDiffViewExtension({ onBlockedEdit: handleBlockedEdit }),
  [handleBlockedEdit]
)
```

---

### Step 3a.6: Update exports

Update `frontend/src/core/editor/codemirror/diffView/index.ts`:

```typescript
// Add exports
export { blockedEditEffect } from './blockedEditEffect'
export { createBlockedEditListener, type BlockedEditCallback } from './blockedEditListener'
```

---

## Alternative: Visual Shake Effect

For a more immediate visual cue, you could also add a brief "shake" animation to the editor when an edit is blocked:

```css
@keyframes blocked-edit-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-2px); }
  75% { transform: translateX(2px); }
}

.cm-editor.blocked-edit-shake {
  animation: blocked-edit-shake 0.15s ease-in-out;
}
```

Apply via the callback:
```typescript
const handleBlockedEdit = useCallback(() => {
  const editorEl = editorRef.current?.getView()?.dom
  if (editorEl) {
    editorEl.classList.add('blocked-edit-shake')
    setTimeout(() => editorEl.classList.remove('blocked-edit-shake'), 150)
  }
  // ... toast logic
}, [])
```

---

## Verification Checklist

- [ ] Typing in DEL region shows toast
- [ ] Toast auto-dismisses after 3s
- [ ] Holding key in DEL region doesn't spam toasts (debounce works)
- [ ] Paste into DEL region shows toast
- [ ] Selection delete spanning DEL region shows toast
- [ ] Toast message is correct for reason type

## Files Created

| File | Purpose |
|------|---------|
| `frontend/src/core/editor/codemirror/diffView/blockedEditEffect.ts` | Effect definition |
| `frontend/src/core/editor/codemirror/diffView/blockedEditListener.ts` | Listener extension |

## Files Modified

| File | Change |
|------|--------|
| `editFilter.ts` | Dispatch effect on block |
| `plugin.ts` | Accept callback option |
| `index.ts` | Export new modules |
| `EditorPanel.tsx` | Wire up toast |

## Next Step

→ Continue to `04-state-sync.md` for save logic.
