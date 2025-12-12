# Phase 1: Foundation

Set up infrastructure without changing any runtime behavior.

---

## Step 1: Install Dependencies

**Goal:** Add `@codemirror/merge` package.

**Files:**
- `frontend/package.json`

**Changes:**
```bash
pnpm add @codemirror/merge
```

**Verification:**
- [ ] App still compiles
- [ ] No visible changes

---

## Step 2: Add EditorMode to Store

**Goal:** Add mode state infrastructure (unused initially).

**Files:**
- `frontend/src/core/stores/useEditorStore.ts`

**Changes:**

```ts
// Add type
export type AIEditorMode = 'changes' | 'aiDraft' | 'original'

// Add to EditorStore interface
interface EditorStore {
  // ... existing fields
  aiEditorMode: AIEditorMode
  setAIEditorMode: (mode: AIEditorMode) => void
}

// Add to create() implementation
aiEditorMode: 'changes',
setAIEditorMode: (mode) => set({ aiEditorMode: mode }),
```

**Verification:**
- [ ] App still works
- [ ] Can verify in React DevTools that state exists

---

## Step 3: Create Extension Factories

**Goal:** Build the CodeMirror extension configurations (unused initially).

**Files:**
- `frontend/src/features/documents/editor/mergeExtensions.ts` (new)
 - `frontend/src/core/editor/codemirror/extensions/markdownBase.ts` (new, shared base extensions)

**Changes:**

```ts
import { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { unifiedMergeView } from '@codemirror/merge'

// Shared markdown/base extensions extracted from CodeMirrorEditor
// Refactor CodeMirrorEditor to consume these as its base config too.
import { markdownEditorExtensions } from '@/core/editor/codemirror/extensions/markdownBase'

/**
 * Extensions for AI Draft mode - plain editor, no diff view.
 */
export const draftExtensions: Extension[] = [
  ...markdownEditorExtensions,
]

/**
 * Extensions for Changes mode - unified diff view.
 * @param baseline - The original content to compare against
 */
export function changesExtensions(baseline: string): Extension[] {
  return [
    ...markdownEditorExtensions,
    unifiedMergeView({
      original: baseline,
      highlightChanges: true,
      mergeControls: true,
      gutter: true,
      syntaxHighlightDeletions: true,
    }),
  ]
}

/**
 * Extensions for Original mode - read-only view.
 */
export const originalExtensions: Extension[] = [
  ...markdownEditorExtensions,
  EditorView.editable.of(false),
]
```

Additionally, update `CodeMirrorEditor` to accept optional extra extensions that are appended to its base config (no behavior change until used):

```ts
// frontend/src/core/editor/codemirror/types.ts
export interface CodeMirrorEditorOptions {
  // ...
  extensions?: Extension[]  // extra extensions appended to the base set
}

// frontend/src/core/editor/codemirror/CodeMirrorEditor.tsx
function CodeMirrorEditor(
  { initialContent = '', onChange, onReady, editable = true, placeholder, autoFocus, className, extensions = [] },
  ref
) {
  // ...
  const baseExtensions = [
    // existing core/editor extensions...
  ]

  const allExtensions = [...baseExtensions, ...extensions]

  const state = EditorState.create({
    doc: initialContent,
    extensions: allExtensions,
  })
  // ...
}
```

**Verification:**
- [ ] File exists and TypeScript compiles
- [ ] No runtime usage yet

---

## Step 4: Create useMergeEditor Hook

**Goal:** Encapsulate merge view logic with Compartment-based mode switching.

**Files:**
- `frontend/src/features/documents/hooks/useMergeEditor.ts` (new)

**Changes:**

```ts
import { useRef, useCallback, useMemo } from 'react'
import { Compartment, type Extension } from '@codemirror/state'
import { changesExtensions, draftExtensions } from '../editor/mergeExtensions'
import type { AIEditorMode } from '@/core/stores/useEditorStore'
import type { CodeMirrorEditorRef } from '@/core/editor/codemirror'

/**
 * Result of useMergeEditor - integrates with CodeMirrorEditor.
 */
export interface UseMergeEditorResult {
  /** Ref passed to CodeMirrorEditor */
  editorRef: React.MutableRefObject<CodeMirrorEditorRef | null>
  /** Switch between changes/aiDraft modes (preserves undo history) */
  switchMode: (mode: Exclude<AIEditorMode, 'original'>) => void
  /** Initial extensions to pass into CodeMirrorEditor (wrapped in a Compartment) */
  initialExtensions: Extension
}

/**
 * Hook for managing a merge editor with history-preserving mode switching.
 *
 * @param baseline - The original content (for diff comparison)
 * @returns Object with viewRef, switchMode, and initialExtensions
 *
 * @example
 * ```tsx
 * const { editorRef, switchMode, initialExtensions } = useMergeEditor(baseline)
 *
 * // On mode change from store
 * useEffect(() => {
 *   if (mode !== 'original') switchMode(mode)
 * }, [mode, switchMode])
 * ```
 */
export function useMergeEditor(baseline: string): UseMergeEditorResult {
  const editorRef = useRef<CodeMirrorEditorRef | null>(null)

  // One Compartment per editor instance (per hook call)
  const modeCompartmentRef = useRef<Compartment | null>(null)
  if (!modeCompartmentRef.current) {
    modeCompartmentRef.current = new Compartment()
  }
  const modeCompartment = modeCompartmentRef.current

  // Switch between changes/aiDraft without losing undo history
  const switchMode = useCallback(
    (mode: Exclude<AIEditorMode, 'original'>) => {
      const view = editorRef.current?.getView()
      if (!view) return

      const extensions =
        mode === 'changes' ? changesExtensions(baseline) : draftExtensions

      view.dispatch({
        effects: modeCompartment.reconfigure(extensions),
      })
    },
    [baseline, modeCompartment]
  )

  // Initial extensions - start in Changes mode by default
  const initialExtensions = useMemo(
    () => modeCompartment.of(changesExtensions(baseline)),
    [baseline, modeCompartment]
  )

  return {
    editorRef,
    switchMode,
    initialExtensions,
  }
}
```

**Verification:**
- [ ] File exists and TypeScript compiles
- [ ] Hook can be imported (but not used yet)

---

## Foundation Complete Checklist

After completing Steps 1-4:

- [ ] `@codemirror/merge` is installed
- [ ] `aiEditorMode` exists in store
- [ ] `mergeExtensions.ts` exports extension factories
- [ ] `useMergeEditor.ts` exports the hook
- [ ] App runs with no visible changes
- [ ] All new code is unused (no runtime behavior change)

**Next:** Proceed to `02-ui-wiring.md`
