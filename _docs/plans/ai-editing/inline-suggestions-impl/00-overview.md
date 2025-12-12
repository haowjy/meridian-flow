# AI Inline Suggestions - Implementation Overview

## Migration Strategy

This implementation migrates from the current `diff-match-patch` approach to `@codemirror/merge` in small, safe steps. Each step should be a separate commit/PR.

## Step Summary

| Step | File | Goal |
|------|------|------|
| 1 | `01-foundation.md` | Install deps, add store state |
| 2 | `01-foundation.md` | Create extension factories |
| 3 | `01-foundation.md` | Create `useMergeEditor` hook |
| 4 | `01-foundation.md` | (foundation complete) |
| 5 | `02-ui-wiring.md` | Add mode switcher UI |
| 6 | `02-ui-wiring.md` | Wire merge view to EditorPanel |
| 7 | `02-ui-wiring.md` | Wire mode switching |
| 8 | `02-ui-wiring.md` | Implement Original mode overlay |
| 9 | `03-polish.md` | Add keyboard shortcuts |
| 10 | `03-polish.md` | Add floating hunk navigator |
| 11 | `03-polish.md` | Styling & polish |
| 12 | `04-cleanup.md` | Remove old implementation |

## Step Dependencies

```
Step 1 (deps) ─┐
Step 2 (store) ┼─→ Step 5 (UI)
Step 3 (ext)   ┤
Step 4 (hook) ─┼─→ Step 6 (wire) → Step 7 (modes) → Step 8 (original)
               │
               └─→ Step 9 (keys) → Step 10 (nav) → Step 11 (style)
                                                         │
                                                         ↓
                                                   Step 12 (cleanup)
```

## Files Created/Modified

### New Files
- `frontend/src/features/documents/editor/mergeExtensions.ts`
- `frontend/src/features/documents/hooks/useMergeEditor.ts`
- `frontend/src/features/documents/components/OriginalOverlay.tsx`
- `frontend/src/features/documents/components/AIHunkNavigator.tsx`

### Modified Files
- `frontend/package.json` - Add `@codemirror/merge`
- `frontend/src/core/stores/useEditorStore.ts` - Add `aiEditorMode`
- `frontend/src/features/documents/components/AIToolbar.tsx` - Mode switcher
- `frontend/src/features/documents/components/EditorPanel.tsx` - Merge view integration
- `frontend/src/globals.css` - Diff styling

### Deleted Files (Step 12)
- `frontend/src/features/documents/hooks/useAIDiff.ts`
- `frontend/src/features/documents/components/DiffDisplay.tsx`

## Key Technical Decisions

1. **History Preservation**: Use a per-editor `Compartment` inside `useMergeEditor` with `reconfigure()` to swap extensions without losing undo history
2. **Original Mode**: Render as overlay to keep main editor state intact while the main editor stays mounted underneath
3. **SOLID Compliance**: Keep `CodeMirrorEditor` as the single abstraction; `useMergeEditor` works with `CodeMirrorEditorRef` (using `ref.getView()`) and owns all merge-specific logic (SRP)
